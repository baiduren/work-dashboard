// 今日视图首页（docs/00-product-brief.md「核心场景 1 今日」、Issue #21、Issue #25、Issue #39、Issue #51）：
// 展示「今天到期 / 已逾期 / 待安排」三组未完成任务（含标签徽标），并提供最小写操作闭环：
// 顶部快速添加（默认今天到期）、点行编辑、行内「完成」与撤销；任务列表上方可按标签筛选；
// 另有数据导出 / 导入入口（Issue #37，docs/01-architecture.md「数据导出 / 导入」）。
// 筛选栏（Issue #51）：q / priority / tagId 写入 URL searchParams，本 Server Component
// 按参数经 lib/db listTasks 重新查询（不在客户端过滤列表）；筛选中空结果显示「无匹配任务」，
// 与空库真空态区分。今日视图 I 工单的前端标签筛选保留，作为轻量快捷方式与服务端筛选并存。
// 数据只经 lib/db 的 listTasks 查询（不直接调用 Prisma client、不发 HTTP）；
// 写操作由交互组件（Client Component）调用现有 HTTP API 后 router.refresh() 回到这里刷新。
// 每组为空显示友好空态，三组全空（如空库）时显示整页空态。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。

import type { Metadata } from "next";

import { BackupActions } from "@/components/backup-actions";
import { QuickAddForm } from "@/components/quick-add-form";
import type { TaskListItem } from "@/components/task-list";
import { TaskFilters } from "@/components/task-filters";
import { TodayBoard, type TodaySectionData } from "@/components/today-board";
import { formatLocalDate } from "@/components/today-form";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";
import { tagExists } from "@/lib/db/tags";
import { hasActiveFilters, readPageTaskFilters, type FilterParamValue } from "@/lib/domain/task-filter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "今日 · 个人工作台",
};

/** 把任务行快照裁剪成展示组件需要的字段（组件不接触数据库类型）。 */
function toListItem(task: TaskRecord): TaskListItem {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    projectId: task.projectId,
    tags: task.tags,
  };
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, FilterParamValue>>;
}) {
  const requestedFilters = readPageTaskFilters(await searchParams);
  // URL 中的 tagId 可能已失效（手工改 URL / 标签被删除）：页面忽略该条件，不整页 500。
  const filters =
    requestedFilters.tagId !== undefined && !(await tagExists(requestedFilters.tagId))
      ? { ...requestedFilters, tagId: undefined }
      : requestedFilters;
  const filtersActive = hasActiveFilters(filters);
  // 三组查询共用同一个 now，保证日期边界一致（避免渲染中途跨天）。
  const now = new Date();
  const [todayTasks, overdueTasks, undatedTasks] = await Promise.all([
    listTasks("today", { now, ...filters }),
    listTasks("overdue", { now, ...filters }),
    listTasks("undated", { now, ...filters }),
  ]);

  const sections: TodaySectionData[] = [
    {
      key: "today",
      heading: "今天到期",
      tasks: todayTasks.map(toListItem),
      overdue: false,
      emptyText: "今天没有到期的任务",
    },
    {
      key: "overdue",
      heading: "已逾期",
      tasks: overdueTasks.map(toListItem),
      overdue: true,
      emptyText: "没有逾期的任务，保持得很好",
    },
    {
      key: "undated",
      heading: "待安排",
      tasks: undatedTasks.map(toListItem),
      overdue: false,
      emptyText: "没有待安排的任务",
    },
  ];
  const total = sections.reduce((sum, section) => sum + section.tasks.length, 0);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-neutral-900">今日</h1>
        <span className="text-sm tabular-nums text-neutral-500">{formatLocalDate(now)}</span>
      </div>

      {/* 筛选栏（Issue #51）：关键词 / 优先级 / 标签写入 URL，按 searchParams 服务端查询。 */}
      <TaskFilters />

      <QuickAddForm />

      {/* 数据备份入口（Issue #37）：导出全量 JSON / 导入恢复，见 docs/01-architecture.md「数据导出 / 导入」。 */}
      <BackupActions />

      {total === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          {filtersActive ? (
            <>
              <p className="text-base font-medium text-neutral-900">无匹配任务</p>
              <p className="mt-2 text-sm text-neutral-500">
                换个关键词或调整筛选条件，也可以点「清除筛选」查看全部未完成任务。
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-medium text-neutral-900">今天没有待处理的任务</p>
              <p className="mt-2 text-sm text-neutral-500">
                在上方输入标题并回车，任务会出现在「今天到期」组。
              </p>
            </>
          )}
        </div>
      ) : (
        <TodayBoard sections={sections} filtersActive={filtersActive} />
      )}
    </main>
  );
}
