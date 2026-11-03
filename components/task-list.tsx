// 任务行展示（docs/01-architecture.md「模块边界」）：纯展示组件，
// 不访问数据库、不发请求，由页面把 lib/db 的查询结果映射成 TaskListItem 传入。
// 展示标题、优先级标记与截止日期（统一 YYYY-MM-DD，docs/02-acceptance.md）；
// overdue 变体（「已逾期」组）用醒目的红色样式标记。

export interface TaskListItem {
  id: string;
  title: string;
  /** lib/domain 约束的 low | medium | high；未知取值按中性样式兜底展示。 */
  priority: string;
  dueDate: Date | null;
}

/** 优先级标记：中性底色的小徽标，避免与逾期样式混淆。 */
const PRIORITY_STYLES: Record<string, { label: string; className: string }> = {
  high: { label: "高", className: "bg-neutral-900 text-white" },
  medium: { label: "中", className: "bg-neutral-100 text-neutral-600" },
  low: { label: "低", className: "bg-neutral-100 text-neutral-400" },
};

const FALLBACK_PRIORITY_STYLE = { label: "中", className: "bg-neutral-100 text-neutral-600" } as const;

/** 截止日期统一格式：YYYY-MM-DD（服务器本地时区）。 */
export function formatDueDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

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

function TaskRow({ task, overdue }: { task: TaskListItem; overdue: boolean }) {
  return (
    <li
      className={
        overdue
          ? "flex items-center justify-between gap-3 rounded-lg border border-l-4 border-red-200 border-l-red-500 bg-red-50 px-3 py-2.5"
          : "flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2.5"
      }
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
            {formatDueDate(task.dueDate)}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** 任务列表：`overdue` 为 true 时按「已逾期」醒目样式渲染（docs/00-product-brief.md「核心场景 1 今日」）。 */
export function TaskList({
  tasks,
  overdue = false,
}: {
  tasks: readonly TaskListItem[];
  overdue?: boolean;
}) {
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} overdue={overdue} />
      ))}
    </ul>
  );
}
