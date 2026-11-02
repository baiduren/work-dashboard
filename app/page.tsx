// 今日视图首页（docs/00-product-brief.md「核心场景 1 今日」、Issue #21）：
// 只读展示「今天到期 / 已逾期 / 待安排」三组未完成任务，已完成任务不出现。
// 数据只经 lib/db 的 listTasks 查询（不直接调用 Prisma client、不发 HTTP）；
// 每组为空显示友好空态，三组全空（如空库）时显示整页空态。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。

import type { Metadata } from "next";

import { TaskList, formatDueDate, type TaskListItem } from "@/components/task-list";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "今日 · 个人工作台",
};

/** 把任务行快照裁剪成展示组件需要的字段（组件不接触数据库类型）。 */
function toListItem(task: TaskRecord): TaskListItem {
  return { id: task.id, title: task.title, priority: task.priority, dueDate: task.dueDate };
}

export default async function TodayPage() {
  // 三组查询共用同一个 now，保证日期边界一致（避免渲染中途跨天）。
  const now = new Date();
  const [todayTasks, overdueTasks, undatedTasks] = await Promise.all([
    listTasks("today", { now }),
    listTasks("overdue", { now }),
    listTasks("undated", { now }),
  ]);

  const sections = [
    {
      key: "today",
      heading: "今天到期",
      tasks: todayTasks,
      overdue: false,
      emptyText: "今天没有到期的任务",
    },
    {
      key: "overdue",
      heading: "已逾期",
      tasks: overdueTasks,
      overdue: true,
      emptyText: "没有逾期的任务，保持得很好",
    },
    {
      key: "undated",
      heading: "待安排",
      tasks: undatedTasks,
      overdue: false,
      emptyText: "没有待安排的任务",
    },
  ];
  const total = todayTasks.length + overdueTasks.length + undatedTasks.length;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-neutral-900">今日</h1>
        <span className="text-sm tabular-nums text-neutral-500">{formatDueDate(now)}</span>
      </div>

      {total === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-medium text-neutral-900">今天没有待处理的任务</p>
          <p className="mt-2 text-sm text-neutral-500">
            添加任务后，今天到期、已逾期与待安排的任务会出现在这里。
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {sections.map((section) => (
            <section key={section.key}>
              <h2 className="flex items-baseline gap-2 text-sm font-semibold text-neutral-900">
                {section.heading}
                <span className="text-xs font-normal tabular-nums text-neutral-400">
                  {section.tasks.length}
                </span>
              </h2>
              <div className="mt-3">
                {section.tasks.length > 0 ? (
                  <TaskList tasks={section.tasks.map(toListItem)} overdue={section.overdue} />
                ) : (
                  <p className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm text-neutral-400">
                    {section.emptyText}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
