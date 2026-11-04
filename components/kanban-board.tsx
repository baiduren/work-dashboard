"use client";

// 看板视图的交互容器（Issue #31，拖拽组件选型见 docs/adr/0003-ui-components.md）：
// dnd-kit 实现同列排序 + 跨列移动（todo / doing / done），数据由 Server Component
// （app/board/page.tsx 调 lib/db listTasks("board")）查询后传入；本组件不直接读写数据库。
//
// 写操作走现有 HTTP API：拖动结束后调用 POST /api/tasks/:id/move，body { status, orderIndex }，
// orderIndex 语义见 docs/01-architecture.md「接口约定」（移除被拖任务后在目标列中的插入下标），
// 换算抽在 components/kanban-form.ts（status 包装）与 components/drag-lists-form.ts
// （Issue #52 起与今日视图共用的通用实现，tests/kanban-form.test.ts 覆盖）。
//
// 交互细节：
// - 乐观更新：拖动结束先本地重排，接口失败回滚到拖动前状态并显示错误提示；
// - 同一任务移动在途时禁用其再次拖动（忽略重复提交）；
// - 指针/触摸传感器用 5px 距离阈值启动拖拽，避免与点击冲突（卡片本身无点击动作）；
// - 键盘可拖拽：Space 拾起 → 方向键移动 → Space 放下，播报文案面向屏幕阅读器；
// - 拖动期间列数据保持不动（DragOverlay 展示跟随指针的卡片副本），落点在拖动结束时计算。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  computeDragTarget,
  moveTaskInColumns,
  statusFromDroppableId,
  type DragMoveTarget,
  type KanbanCardData,
  type KanbanColumns,
} from "@/components/kanban-form";
import {
  createCardFirstCollisionDetection,
  DragToast,
  SortableListContainer,
  TOAST_AUTO_DISMISS_MS,
  useAutoDismissToast,
  useSortableSensors,
} from "@/components/sortable-lists";
import { PRIORITY_STYLES } from "@/components/task-list";
import { apiErrorMessage, formatLocalDate } from "@/components/today-form";
import { TASK_STATUSES, type TaskStatus } from "@/lib/domain/task";

/** 列定义：与任务状态一一对应（docs/01-architecture.md「数据模型」）。 */
const COLUMN_META: readonly { status: TaskStatus; heading: string; emptyText: string }[] = [
  { status: "todo", heading: "待办", emptyText: "待办还没有任务，把卡片拖到这里" },
  { status: "doing", heading: "进行中", emptyText: "没有进行中的任务，把卡片拖到这里" },
  { status: "done", heading: "已完成", emptyText: "还没有已完成的任务，把卡片拖到这里" },
];

const COLUMN_NAMES: Record<TaskStatus, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};

export function KanbanBoard({ columns: initialColumns }: { columns: KanbanColumns }) {
  const router = useRouter();
  const [columns, setColumns] = useState<KanbanColumns>(initialColumns);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const { toast, setToast } = useAutoDismissToast<string>(TOAST_AUTO_DISMISS_MS);

  const idColumns = useMemo(
    () => ({
      todo: columns.todo.map((card) => card.id),
      doing: columns.doing.map((card) => card.id),
      done: columns.done.map((card) => card.id),
    }),
    [columns],
  );

  // 服务端数据到达后回填（router.refresh() 之后以落库结果为准）；
  // 移动在途时跳过，避免覆盖尚未确认的乐观更新。
  useEffect(() => {
    if (movingIds.size === 0) setColumns(initialColumns);
  }, [initialColumns, movingIds]);

  // 指针/触摸共用 PointerSensor：移动 5px 才启动拖拽（Issue #31 的距离阈值要求）。
  const sensors = useSortableSensors();

  // 落点判定：卡片优先于列容器（卡片决定插入下标，列空白处决定追加到列尾）。
  const collisionDetection: CollisionDetection = useMemo(
    () => createCardFirstCollisionDetection((id) => statusFromDroppableId(id) !== null),
    [],
  );

  const findCard = useCallback(
    (id: string): KanbanCardData | null => {
      for (const status of TASK_STATUSES) {
        const card = columns[status].find((entry) => entry.id === id);
        if (card) return card;
      }
      return null;
    },
    [columns],
  );

  // 屏幕阅读器播报（键盘拖拽提示，Issue #31 交互细节）。
  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const card = findCard(String(active.id));
        return card ? `开始拖动任务「${card.title}」。用方向键移动，按空格放下。` : undefined;
      },
      onDragOver({ over }) {
        if (!over) return undefined;
        const status = statusFromDroppableId(String(over.id));
        if (status) return `移动到${COLUMN_NAMES[status]}列`;
        const card = findCard(String(over.id));
        return card ? `移动到「${card.title}」上方` : undefined;
      },
      onDragEnd({ over }) {
        return over ? "任务已放下。" : "没有找到放置位置，任务回到原位。";
      },
      onDragCancel() {
        return "拖动已取消，任务回到原位。";
      },
    }),
    [findCard],
  );

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    const taskId = String(active.id);
    // 同一任务移动在途时忽略新拖动（useSortable 已禁用其启动，这里兜底）。
    if (movingIds.has(taskId)) return;

    const target = computeDragTarget(idColumns, taskId, over ? String(over.id) : null);
    if (!target) return; // 原位 / 无落点：不发请求

    const snapshot = columns; // 拖动前状态，接口失败时回滚
    setColumns((previous) => moveTaskInColumns(previous, taskId, target));
    void submitMove(taskId, target, snapshot);
  }

  async function submitMove(taskId: string, target: DragMoveTarget, snapshot: KanbanColumns) {
    setMovingIds((previous) => new Set(previous).add(taskId));
    try {
      const response = await fetch(`/api/tasks/${taskId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (response.ok) {
        router.refresh(); // 以服务端落库结果为准回填
        return;
      }
      setColumns(snapshot); // 接口失败：回滚到拖动前状态
      setToast(await apiErrorMessage(response, "移动失败，请稍后再试"));
    } catch {
      setColumns(snapshot);
      setToast("网络异常，请稍后再试");
    } finally {
      setMovingIds((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    }
  }

  const activeCard = activeId ? findCard(activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      accessibility={{ announcements }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* 窄屏三列横向滚动：列宽固定 shrink-0，不挤压、不换行（Issue #31 响应式要求）。 */}
      <div className="mt-6 flex items-start gap-4 overflow-x-auto pb-4">
        {COLUMN_META.map((meta) => (
          <KanbanColumn
            key={meta.status}
            meta={meta}
            cards={columns[meta.status]}
            movingIds={movingIds}
            draggingId={activeId}
          />
        ))}
      </div>

      <DragOverlay>{activeCard ? <OverlayCard card={activeCard} /> : null}</DragOverlay>

      {toast ? <DragToast message={toast} /> : null}
    </DndContext>
  );
}

function KanbanColumn({
  meta,
  cards,
  movingIds,
  draggingId,
}: {
  meta: { status: TaskStatus; heading: string; emptyText: string };
  cards: readonly KanbanCardData[];
  movingIds: ReadonlySet<string>;
  draggingId: string | null;
}) {
  // 列容器也是落点：拖到列空白处 / 空列时追加到列尾。
  const items = useMemo(() => cards.map((card) => card.id), [cards]);

  return (
    <SortableListContainer
      listId={meta.status}
      ariaLabel={`${COLUMN_NAMES[meta.status]}列`}
      itemIds={items}
      className={(isOver) =>
        `flex w-72 shrink-0 flex-col rounded-xl border bg-neutral-100/70 p-2 ${
          isOver ? "border-neutral-900" : "border-neutral-200"
        }`
      }
    >
      <h2 className="flex items-baseline justify-between px-1 pb-1 pt-0.5 text-sm font-semibold text-neutral-900">
        {meta.heading}
        <span className="text-xs font-normal tabular-nums text-neutral-400">{cards.length}</span>
      </h2>
      <ul className="flex min-h-28 flex-1 flex-col gap-2">
        {cards.map((card) => (
          <KanbanCard
            key={card.id}
            card={card}
            disabled={movingIds.has(card.id)}
            dimmed={draggingId === card.id}
          />
        ))}
        {cards.length === 0 ? (
          <li className="flex min-h-28 flex-1 items-center justify-center rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-sm text-neutral-400">
            {meta.emptyText}
          </li>
        ) : null}
      </ul>
    </SortableListContainer>
  );
}

function KanbanCard({
  card,
  disabled,
  dimmed,
}: {
  card: KanbanCardData;
  disabled: boolean;
  dimmed: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled,
    data: { type: "card" },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`拖动「${card.title}」`}
      className={`flex touch-none select-none items-start gap-2 rounded-lg border px-3 py-2.5 ${
        card.overdue
          ? "border-l-4 border-red-200 border-l-red-500 bg-red-50"
          : "border-neutral-200 bg-white"
      } ${disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"} ${
        dimmed || isDragging ? "opacity-40" : ""
      } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900`}
    >
      <CardFace card={card} />
    </li>
  );
}

/** 卡片内容（列表卡片与拖拽浮层共用）：标题、优先级徽标、截止日期，约定同 components/task-list。 */
function CardFace({ card }: { card: KanbanCardData }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
        {card.title}
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">
        <PriorityBadge priority={card.priority} />
        {card.dueDate ? (
          <span
            className={`text-xs tabular-nums ${
              card.overdue ? "font-semibold text-red-600" : "text-neutral-500"
            }`}
          >
            {formatLocalDate(card.dueDate)}
          </span>
        ) : null}
      </span>
    </>
  );
}

/** 拖动跟随指针的卡片副本（视觉增强，不参与落点计算）。 */
function OverlayCard({ card }: { card: KanbanCardData }) {
  return (
    <div
      className={`flex w-72 items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg ring-1 ring-neutral-900/10 ${
        card.overdue
          ? "border-l-4 border-red-200 border-l-red-500 bg-red-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <CardFace card={card} />
    </div>
  );
}

/** 优先级徽标：与 components/task-list 的样式约定一致（逾期红样式不与徽标混淆）。 */
function PriorityBadge({ priority }: { priority: string }) {
  const style = PRIORITY_STYLES[priority] ?? { label: "中", className: "bg-neutral-100 text-neutral-600" };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}
