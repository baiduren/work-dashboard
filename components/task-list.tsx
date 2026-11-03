"use client";

// 任务行交互组件（Issue #25、docs/01-architecture.md「模块边界」）：
// 展示标题、优先级标记与截止日期（统一 YYYY-MM-DD），并承接两个写操作入口：
// - 点击行主体 → onEdit 打开编辑弹层（数据由父级 TodayBoard 持有）；
// - 「完成」按钮 → onComplete 调 PATCH /api/tasks/:id 设 status=done。
// 组件本身只回调、不发请求；列表数据仍由 Server Component 查询后传入。

import { formatLocalDate } from "@/components/today-form";

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
}

/** 优先级标记：中性底色的小徽标，避免与逾期样式混淆（编辑弹层的下拉标签也复用这里的文案）。 */
export const PRIORITY_STYLES: Record<string, { label: string; className: string }> = {
  high: { label: "高", className: "bg-neutral-900 text-white" },
  medium: { label: "中", className: "bg-neutral-100 text-neutral-600" },
  low: { label: "低", className: "bg-neutral-100 text-neutral-400" },
};

const FALLBACK_PRIORITY_STYLE = { label: "中", className: "bg-neutral-100 text-neutral-600" } as const;

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

function TaskRow({
  task,
  overdue,
  completing,
  onEdit,
  onComplete,
}: {
  task: TaskListItem;
  overdue: boolean;
  completing: boolean;
  onEdit: (task: TaskListItem) => void;
  onComplete: (task: TaskListItem) => void;
}) {
  return (
    <li
      className={
        overdue
          ? "flex items-center justify-between gap-3 rounded-lg border border-l-4 border-red-200 border-l-red-500 bg-red-50 px-3 py-2.5"
          : "flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5"
      }
    >
      {/* 行主体可点击打开编辑弹层；键盘可用（原生 button），aria-haspopup 标注弹出弹层。 */}
      <button
        type="button"
        onClick={() => onEdit(task)}
        aria-haspopup="dialog"
        aria-label={`编辑任务：${task.title}`}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      >
        <span className="min-w-0 truncate text-sm font-medium text-neutral-900">{task.title}</span>
        <span className="flex shrink-0 items-center gap-2">
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
      </button>
      <button
        type="button"
        onClick={() => onComplete(task)}
        disabled={completing}
        aria-label={`标记完成：${task.title}`}
        className="shrink-0 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {completing ? "完成中…" : "完成"}
      </button>
    </li>
  );
}

/** 任务列表：`overdue` 为 true 时按「已逾期」醒目样式渲染（docs/00-product-brief.md「核心场景 1 今日」）。 */
export function TaskList({
  tasks,
  overdue = false,
  completingId,
  onEdit,
  onComplete,
}: {
  tasks: readonly TaskListItem[];
  overdue?: boolean;
  completingId: string | null;
  onEdit: (task: TaskListItem) => void;
  onComplete: (task: TaskListItem) => void;
}) {
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          overdue={overdue}
          completing={completingId === task.id}
          onEdit={onEdit}
          onComplete={onComplete}
        />
      ))}
    </ul>
  );
}
