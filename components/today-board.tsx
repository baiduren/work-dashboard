"use client";

// 今日视图的交互容器（Issue #25；Issue #39 增加标签徽标筛选；Issue #51 服务端筛选并存；
// Issue #52 增加组内拖拽排序）：持有编辑弹层、完成/撤销、行隐藏、标签筛选与组内排序的客户端状态。
// 数据获取仍由 Server Component 完成（app/page.tsx 查询后传入分节数组）；
// 写操作全部走现有 HTTP API，成功后 router.refresh() 让 Server Component 重新渲染
// （docs/01-architecture.md「模块边界」）：
// - 完成：PATCH status=done 成功后立即隐藏该行并弹出「已标记完成 · 撤销」提示（6 秒自动消失）；
// - 撤销：PATCH status=完成前的状态（todo/doing），行回到原组；
// - 标签筛选（Issue #39）：「全部标签」+ 各标签下拉，选中后按当前列表内 tags
//   前端过滤，作为轻量快捷方式保留；
// - 服务端筛选（Issue #51）：q / priority / tagId 由 app/page.tsx 按 URL searchParams 查询，
//   本组件只接收 filtersActive 用于区分「该组无匹配任务」与普通空态；
// - 组内拖拽排序（Issue #52）：复用看板的 dnd-kit 设施与 components/drag-lists-form.ts
//   的纯函数，拖动结束后 POST /api/tasks/:id/move（body { status, orderIndex }，与看板同构），
//   乐观更新失败回滚；跨组拖拽不触发（改截止日期属编辑弹层操作，非本工单范围）；
// - 已完成任务的查询语义不变：done 不出现在今日视图（lib/db listTasks）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { EditTaskModal } from "@/components/edit-task-modal";
import {
  computeDragTargetInLists,
  listIdFromDroppableId,
  type DragIdLists,
} from "@/components/drag-lists-form";
import {
  createCardFirstCollisionDetection,
  DragToast,
  SortableListContainer,
  useAutoDismissToast,
  useSortableSensors,
} from "@/components/sortable-lists";
import {
  TaskList,
  TaskRowPreview,
  type TaskListItem,
  type TaskTagItem,
} from "@/components/task-list";
import {
  apiErrorMessage,
  computeTodayMoveTarget,
  moveTaskInTodaySection,
  type TodayMoveTarget,
} from "@/components/today-form";
import { parseStatus, type TaskStatus } from "@/lib/domain/task";

export interface TodaySectionData {
  key: "today" | "overdue" | "undated";
  heading: string;
  tasks: TaskListItem[];
  overdue: boolean;
  emptyText: string;
}

const TODAY_SECTION_KEYS = ["today", "overdue", "undated"] as const;
type TodaySectionKey = (typeof TODAY_SECTION_KEYS)[number];

function isTodaySectionKey(value: string | null): value is TodaySectionKey {
  return value !== null && (TODAY_SECTION_KEYS as readonly string[]).includes(value);
}

/** 完成 / 撤销 / 拖拽失败共用的提示；kind=error 复用同一位置展示失败文案。 */
type ToastState =
  | { kind: "completed"; task: TaskListItem; previousStatus: TaskStatus }
  | { kind: "error"; message: string };

export function TodayBoard({
  sections: initialSections,
  filtersActive = false,
}: {
  sections: readonly TodaySectionData[];
  /** URL 中带有 q / priority / tagId 服务端筛选（Issue #51）：空组显示「无匹配任务」文案。 */
  filtersActive?: boolean;
}) {
  const router = useRouter();
  const [sections, setSections] = useState<TodaySectionData[]>(() => cloneSections(initialSections));
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskListItem | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const { toast, setToast } = useAutoDismissToast<ToastState>();
  const [undoing, setUndoing] = useState(false);
  // 标签筛选："" 表示「全部标签」；选中后按当前列表内 tags 前端过滤（Issue #39）。
  const [tagFilter, setTagFilter] = useState("");

  // 服务端数据到达后回填（router.refresh() 之后以落库结果为准）；
  // 移动在途时先记下新数据、待移动确认后再应用，避免用旧 props 覆盖乐观更新。
  // 只在 props 引用真正变化时回填：移动结束后移动队列清空不应触发“回滚到旧顺序”。
  const serverSectionsRef = useRef(initialSections);
  const serverSectionsPendingRef = useRef(false);
  useEffect(() => {
    if (serverSectionsRef.current !== initialSections) {
      serverSectionsRef.current = initialSections;
      serverSectionsPendingRef.current = true;
    }
    if (!serverSectionsPendingRef.current || movingIds.size > 0) return;
    serverSectionsPendingRef.current = false;
    setSections(cloneSections(initialSections));
  }, [initialSections, movingIds]);

  // 汇总当前列表里出现过的标签（按名称排序去重），作为筛选下拉的选项。
  const knownTags = useMemo<TaskTagItem[]>(() => {
    const byId = new Map<string, TaskTagItem>();
    for (const section of sections) {
      for (const task of section.tasks) {
        for (const tag of task.tags ?? []) {
          if (!byId.has(tag.id)) byId.set(tag.id, tag);
        }
      }
    }
    return [...byId.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, [sections]);

  // 排序换算使用完整分节数据（含被标签筛选隐藏的行）：隐藏行仍占用状态列内位置，
  // 按完整列表换算才能让落库顺序与再次显示时的顺序一致。
  const idLists = useMemo<DragIdLists>(() => {
    const lists: Record<string, string[]> = {};
    for (const section of sections) {
      lists[section.key] = section.tasks.map((task) => task.id);
    }
    return lists;
  }, [sections]);

  const sensors = useSortableSensors();
  const collisionDetection: CollisionDetection = useMemo(
    () => createCardFirstCollisionDetection((id) => isTodaySectionKey(listIdFromDroppableId(id))),
    [],
  );

  const findTask = useCallback(
    (id: string): TaskListItem | null => {
      for (const section of sections) {
        const task = section.tasks.find((entry) => entry.id === id);
        if (task) return task;
      }
      return null;
    },
    [sections],
  );

  // 屏幕阅读器播报（键盘拖拽提示，与看板同一交互约定）。
  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const task = findTask(String(active.id));
        return task ? `开始拖动任务「${task.title}」。用方向键移动，按空格放下。` : undefined;
      },
      onDragOver({ over }) {
        if (!over) return undefined;
        const overId = String(over.id);
        const sectionKey = listIdFromDroppableId(overId);
        if (isTodaySectionKey(sectionKey)) {
          const section = sections.find((entry) => entry.key === sectionKey);
          return section ? `移动到「${section.heading}」组` : undefined;
        }
        const task = findTask(overId);
        return task ? `移动到「${task.title}」位置` : undefined;
      },
      onDragEnd({ over }) {
        return over ? "任务已放下。" : "没有找到放置位置，任务回到原位。";
      },
      onDragCancel() {
        return "拖动已取消，任务回到原位。";
      },
    }),
    [findTask, sections],
  );

  async function handleComplete(task: TaskListItem) {
    if (completingId) return;
    setCompletingId(task.id);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (response.ok) {
        // 撤销时恢复完成前的状态（todo/doing）；未知取值回退 todo（parseStatus 校验）。
        let previousStatus: TaskStatus = "todo";
        try {
          previousStatus = parseStatus(task.status);
        } catch {
          // 理论上不出现（今日视图只含未完成任务），回退 todo 保证可撤销。
        }
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.add(task.id);
          return next;
        });
        setToast({ kind: "completed", task, previousStatus });
        router.refresh();
      } else {
        setToast({
          kind: "error",
          message: await apiErrorMessage(response, "标记完成失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "error", message: "网络异常，请稍后再试" });
    } finally {
      setCompletingId(null);
    }
  }

  async function handleUndo() {
    if (toast?.kind !== "completed" || undoing) return;
    const { task, previousStatus } = toast;
    setUndoing(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: previousStatus }),
      });
      if (response.ok) {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
        setToast(null);
        router.refresh();
      } else {
        setToast({
          kind: "error",
          message: await apiErrorMessage(response, "撤销失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "error", message: "网络异常，请稍后再试" });
    } finally {
      setUndoing(false);
    }
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
  }

  function handleDragCancel() {
    setActiveId(null);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    const taskId = String(active.id);
    // 同一任务移动在途时忽略新拖动（把手已禁用，这里兜底）。
    if (movingIds.has(taskId)) return;
    if (!over) return;

    const target = computeDragTargetInLists(idLists, taskId, String(over.id));
    if (!target) return;

    // 今日视图只做组内上下移动：落到别的组不触发（跨组改日期属编辑弹层操作）。
    const sourceSection = sections.find((section) =>
      section.tasks.some((task) => task.id === taskId),
    );
    if (!sourceSection || target.listId !== sourceSection.key) return;

    const moveTarget = computeTodayMoveTarget(
      sourceSection.tasks,
      taskId,
      target.orderIndex,
    );
    if (!moveTarget) return;

    const snapshot = sections; // 拖动前状态，接口失败时回滚
    setSections((previous) =>
      previous.map((section) =>
        section.key === sourceSection.key
          ? { ...section, tasks: moveTaskInTodaySection(section.tasks, taskId, target.orderIndex) }
          : section,
      ),
    );
    void submitMove(taskId, moveTarget, snapshot);
  }

  async function submitMove(
    taskId: string,
    target: TodayMoveTarget,
    snapshot: TodaySectionData[],
  ) {
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
      setSections(snapshot); // 接口失败：回滚到拖动前状态
      setToast({
        kind: "error",
        message: await apiErrorMessage(response, "移动失败，请稍后再试"),
      });
    } catch {
      setSections(snapshot);
      setToast({ kind: "error", message: "网络异常，请稍后再试" });
    } finally {
      setMovingIds((previous) => {
        const next = new Set(previous);
        next.delete(taskId);
        return next;
      });
    }
  }

  const visibleSections = sections
    .map((section) => ({
      ...section,
      tasks: section.tasks.filter(
        (task) =>
          !hiddenIds.has(task.id) &&
          (tagFilter === "" || (task.tags ?? []).some((tag) => tag.id === tagFilter)),
      ),
    }));

  const activeTask = activeId ? findTask(activeId) : null;
  const activeOverdue = activeTask
    ? sections.find((section) => section.tasks.some((task) => task.id === activeTask.id))
        ?.overdue ?? false
    : false;

  return (
    <div className="mt-6 space-y-8">
      {knownTags.length > 0 ? (
        <div className="flex items-center gap-2">
          <label
            htmlFor="today-tag-filter"
            className="shrink-0 text-sm font-medium text-neutral-700"
          >
            按标签筛选
          </label>
          <select
            id="today-tag-filter"
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            aria-label="按标签筛选"
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-900"
          >
            <option value="">全部标签</option>
            {knownTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {visibleSections.map((section) => {
          const visibleTaskIds = section.tasks.map((task) => task.id);
          return (
            <SortableListContainer
              key={section.key}
              listId={section.key}
              ariaLabel={`${section.heading}组`}
              itemIds={visibleTaskIds}
              className={(isOver) =>
                `rounded-xl ${isOver ? "ring-2 ring-neutral-900/10" : ""}`
              }
            >
              <h2 className="flex items-baseline gap-2 text-sm font-semibold text-neutral-900">
                {section.heading}
                <span className="text-xs font-normal tabular-nums text-neutral-400">
                  {section.tasks.length}
                </span>
              </h2>
              <div className="mt-3">
                {section.tasks.length > 0 ? (
                  <TaskList
                    tasks={section.tasks}
                    overdue={section.overdue}
                    completingId={completingId}
                    onEdit={setEditing}
                    onComplete={handleComplete}
                    sortable={{ disabledIds: movingIds, draggingId: activeId }}
                  />
                ) : (
                  <p className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm text-neutral-400">
                    {tagFilter !== ""
                      ? "该组没有带选中标签的任务"
                      : filtersActive
                        ? "该组无匹配任务"
                        : section.emptyText}
                  </p>
                )}
              </div>
            </SortableListContainer>
          );
        })}

        <DragOverlay>
          {activeTask ? (
            <div className="w-[36rem] max-w-[90vw]">
              <TaskRowPreview task={activeTask} overdue={activeOverdue} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {editing ? (
        <EditTaskModal
          key={editing.id}
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => router.refresh()}
        />
      ) : null}

      {toast ? (
        toast.kind === "completed" ? (
          <div
            role="status"
            aria-live="polite"
            className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg"
          >
            <span className="flex items-center gap-2">
              <span className="max-w-[16rem] truncate">已标记完成「{toast.task.title}」</span>
              <span aria-hidden="true" className="text-neutral-500">
                ·
              </span>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoing}
                className="font-medium underline underline-offset-2 hover:text-neutral-300 disabled:opacity-60"
              >
                {undoing ? "撤销中…" : "撤销"}
              </button>
            </span>
          </div>
        ) : (
          <DragToast message={toast.message} />
        )
      ) : null}
    </div>
  );
}

/** 复制分节数据：本地状态需要可变数组做乐观重排，且不改写 Server Component 传入的 props。 */
function cloneSections(sections: readonly TodaySectionData[]): TodaySectionData[] {
  return sections.map((section) => ({ ...section, tasks: [...section.tasks] }));
}
