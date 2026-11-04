"use client";

// 任务行交互组件（Issue #25、Issue #27、Issue #39、Issue #52、docs/01-architecture.md「模块边界」）：
// 展示标题、标签徽标、优先级标记与截止日期（统一 YYYY-MM-DD），并承接两个写操作入口：
// - 点击行主体 → onEdit 打开编辑弹层（数据由父级 TodayBoard 持有）；
// - 「完成」按钮 → onComplete 调 PATCH /api/tasks/:id 设 status=done。
// 组件本身只回调、不发请求；列表数据仍由 Server Component 查询后传入。
// 只读形态（Issue #27，项目详情页复用）：不传 onEdit / onComplete 时行不可点击、
// 无「完成」按钮；showStatus 为 true 时为进行中/已完成任务渲染状态徽标
// （今日视图默认关闭，展示行为不变）。
// 标签徽标（Issue #39）：彩色小圆点（ColorDot 风格）+ 名称，无标签不占位。
// 组内拖拽（Issue #52）：sortable 传入时每行左侧渲染拖拽把手（键盘与指针均可拖拽），
// 行主体与「完成」按钮保持原有交互——拖拽把手单独承接 dnd-kit 的 listeners，
// 避免 Space 键在按钮上被拖拽传感器抢占（与看板卡片整块可拖的差异见组件注释）。

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { CSSProperties } from "react";

import { ColorDot } from "@/components/color-dot";
import { formatLocalDate } from "@/components/today-form";

/** 任务行展示的标签摘要（lib/db TaskTagSummary 的展示形态）。 */
export interface TaskTagItem {
  id: string;
  name: string;
  color: string | null;
}

export interface TaskListItem {
  id: string;
  title: string;
  /** 编辑弹层预填用；完成后撤销时还原任务内容不经过本字段。 */
  notes: string | null;
  /** 期望 todo | doing（done 不出现在今日视图）；撤销完成时经 parseStatus 校验后还原。 */
  status: string;
  /** lib/domain 约束的 low | medium | high；未知取值按中性样式兜底展示。 */
  priority: string;
  dueDate: Date | null;
  /** 所属项目 id（null = 无项目）；编辑弹层「所属项目」下拉预填用（Issue #27）。 */
  projectId: string | null;
  /** 所属项目名（回顾页等只读场景传入，Issue #44）；未提供时不渲染、不占位。 */
  projectName?: string;
  /** 所属项目颜色（projectName 徽标圆点用色）；未提供时渲染中性灰点。 */
  projectColor?: string | null;
  /** 绑定的标签摘要（按标签名升序）；未提供时不渲染徽标（Issue #39）。 */
  tags?: TaskTagItem[];
}

/** 优先级标记：中性底色的小徽标，避免与逾期样式混淆（编辑弹层的下拉标签也复用这里的文案）。 */
export const PRIORITY_STYLES: Record<string, { label: string; className: string }> = {
  high: { label: "高", className: "bg-neutral-900 text-white" },
  medium: { label: "中", className: "bg-neutral-100 text-neutral-600" },
  low: { label: "低", className: "bg-neutral-100 text-neutral-400" },
};

const FALLBACK_PRIORITY_STYLE = { label: "中", className: "bg-neutral-100 text-neutral-600" } as const;

/** 状态徽标（showStatus 时使用）：进行中 / 已完成；todo 为默认态不渲染徽标。 */
const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  doing: { label: "进行中", className: "bg-neutral-100 text-neutral-600" },
  done: { label: "已完成", className: "bg-neutral-100 text-neutral-400" },
};

function PriorityBadge({ priority }: { priority: string }) {
  const style = PRIORITY_STYLES[priority] ?? FALLBACK_PRIORITY_STYLE;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_BADGES[status];
  if (!style) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}

/** 标签徽标（Issue #39）：彩色小圆点 + 名称；无标签不渲染、不占位。 */
function TagBadge({ tag }: { tag: TaskTagItem }) {
  return (
    <span
      data-testid="tag-badge"
      className="inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 py-0.5 pl-1.5 pr-2 text-xs text-neutral-600"
    >
      <ColorDot color={tag.color} />
      <span className="min-w-0 truncate">{tag.name}</span>
    </span>
  );
}

/** 所属项目徽标（Issue #44，回顾页传入 projectName 时渲染）：项目色圆点 + 名称；未提供不占位。 */
function ProjectBadge({ name, color }: { name: string; color: string | null }) {
  return (
    <span
      data-testid="project-badge"
      className="inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 py-0.5 pl-1.5 pr-2 text-xs text-neutral-600"
    >
      <ColorDot color={color} />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** 拖拽把手需要从 useSortable 透传到行上的属性与样式。 */
interface TaskRowDrag {
  setNodeRef: (node: HTMLLIElement | null) => void;
  style: CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  disabled: boolean;
  dragging: boolean;
}

function TaskRow({
  task,
  overdue,
  completing,
  showStatus,
  onEdit,
  onComplete,
  drag,
}: {
  task: TaskListItem;
  overdue: boolean;
  completing: boolean;
  showStatus?: boolean;
  onEdit?: (task: TaskListItem) => void;
  onComplete?: (task: TaskListItem) => void;
  drag?: TaskRowDrag;
}) {
  const interactive = onEdit !== undefined && onComplete !== undefined;
  return (
    <li
      ref={drag?.setNodeRef}
      style={drag?.style}
      className={`${
        overdue
          ? "flex items-center justify-between gap-3 rounded-lg border border-l-4 border-red-200 border-l-red-500 bg-red-50 px-3 py-2.5"
          : "flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5"
      } ${drag?.dragging ? "opacity-40" : ""}`}
    >
      {drag ? (
        // 拖拽把手：只在这里挂 dnd-kit 的 listeners，按钮与行主体的点击/键盘行为不变。
        <button
          type="button"
          {...drag.attributes}
          {...drag.listeners}
          disabled={drag.disabled}
          aria-label={`拖动任务：${task.title}`}
          className={`-ml-1 shrink-0 touch-none select-none rounded p-1 text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 ${
            drag.disabled ? "cursor-default opacity-40" : "cursor-grab hover:text-neutral-700 active:cursor-grabbing"
          }`}
        >
          <GripIcon />
        </button>
      ) : null}
      {/* 可编辑视图：行主体可点击打开编辑弹层（键盘可用，原生 button）；
          只读视图（项目详情页）：行主体为纯展示，不可点击。 */}
      {interactive ? (
        <button
          type="button"
          onClick={() => onEdit(task)}
          aria-haspopup="dialog"
          aria-label={`编辑任务：${task.title}`}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          <RowContent task={task} overdue={overdue} showStatus={showStatus} />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <RowContent task={task} overdue={overdue} showStatus={showStatus} />
        </div>
      )}
      {onComplete ? (
        <button
          type="button"
          onClick={() => onComplete(task)}
          disabled={completing}
          aria-label={`标记完成：${task.title}`}
          className="shrink-0 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {completing ? "完成中…" : "完成"}
        </button>
      ) : null}
    </li>
  );
}

/**
 * 可拖拽任务行（Issue #52）：useSortable 绑定行节点与拖拽把手；
 * 行主体、「完成」按钮与编辑弹层入口不挂 listeners，Space / 回车仍按原语义工作。
 */
function SortableTaskRow(props: {
  task: TaskListItem;
  overdue: boolean;
  completing: boolean;
  showStatus?: boolean;
  onEdit?: (task: TaskListItem) => void;
  onComplete?: (task: TaskListItem) => void;
  disabled: boolean;
  dragging: boolean;
}) {
  const { task, disabled, dragging, ...rowProps } = props;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: task.id,
    disabled,
    data: { type: "card" },
  });

  return (
    <TaskRow
      {...rowProps}
      task={task}
      drag={{
        setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        attributes,
        listeners,
        disabled,
        dragging,
      }}
    />
  );
}

/** 拖拽把手图标（纯装饰，可访问名称由按钮的 aria-label 提供）。 */
function GripIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
      <circle cx="6" cy="5" r="1.4" />
      <circle cx="14" cy="5" r="1.4" />
      <circle cx="6" cy="10" r="1.4" />
      <circle cx="14" cy="10" r="1.4" />
      <circle cx="6" cy="15" r="1.4" />
      <circle cx="14" cy="15" r="1.4" />
    </svg>
  );
}

function RowContent({
  task,
  overdue,
  showStatus,
}: {
  task: TaskListItem;
  overdue: boolean;
  showStatus?: boolean;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-neutral-900">{task.title}</span>
        {task.tags && task.tags.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1">
            {task.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
          </span>
        ) : null}
        {task.projectName ? <ProjectBadge name={task.projectName} color={task.projectColor ?? null} /> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {showStatus ? <StatusBadge status={task.status} /> : null}
        <PriorityBadge priority={task.priority} />
        {task.dueDate ? (
          <span
            className={`text-xs tabular-nums ${
              overdue ? "font-semibold text-red-600" : "text-neutral-500"
            }`}
          >
            {formatLocalDate(task.dueDate)}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * 拖拽浮层里的任务行副本（Issue #52）：只展示行内容，不带编辑 / 完成按钮与拖拽把手，
 * 视觉与行主体一致；宽度由调用方（DragOverlay 容器）控制。
 */
export function TaskRowPreview({ task, overdue }: { task: TaskListItem; overdue: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 shadow-lg ring-1 ring-neutral-900/10 ${
        overdue
          ? "border-l-4 border-red-200 border-l-red-500 bg-red-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <RowContent task={task} overdue={overdue} />
      </div>
    </div>
  );
}

/** 组内拖拽状态：在途任务禁用再次拖拽，正在拖动的行淡化（Issue #52）。 */
export interface TaskListSortableOptions {
  disabledIds: ReadonlySet<string>;
  draggingId: string | null;
}

/**
 * 任务列表：`overdue` 为 true 时按「已逾期」醒目样式渲染（docs/00-product-brief.md「核心场景 1 今日」）。
 * 传入 onEdit + onComplete 为可编辑形态（今日视图）；两者都不传为只读形态（项目详情页），
 * 此时 showStatus 控制是否渲染进行中/已完成状态徽标。
 * 传入 sortable 时每行左侧出现拖拽把手（今日视图组内排序，Issue #52）；只读场景不传。
 */
export function TaskList({
  tasks,
  overdue = false,
  completingId,
  showStatus = false,
  onEdit,
  onComplete,
  sortable,
}: {
  tasks: readonly TaskListItem[];
  overdue?: boolean;
  completingId?: string | null;
  showStatus?: boolean;
  onEdit?: (task: TaskListItem) => void;
  onComplete?: (task: TaskListItem) => void;
  sortable?: TaskListSortableOptions;
}) {
  return (
    <ul className="space-y-2">
      {tasks.map((task) =>
        sortable ? (
          <SortableTaskRow
            key={task.id}
            task={task}
            overdue={overdue}
            completing={completingId === task.id}
            showStatus={showStatus}
            onEdit={onEdit}
            onComplete={onComplete}
            disabled={sortable.disabledIds.has(task.id)}
            dragging={sortable.draggingId === task.id}
          />
        ) : (
          <TaskRow
            key={task.id}
            task={task}
            overdue={overdue}
            completing={completingId === task.id}
            showStatus={showStatus}
            onEdit={onEdit}
            onComplete={onComplete}
          />
        ),
      )}
    </ul>
  );
}
