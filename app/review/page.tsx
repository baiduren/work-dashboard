// 周回顾视图（Issue #44；docs/00-product-brief.md「核心场景 5 回顾」：按周查看完成情况）：
// 顶部周区间标题 + 「上一周 / 本周 / 下一周」切换（?week=YYYY-MM-DD 查询参数定位任意一周，
// 缺省本周，非法值回退本周），统计摘要「本周完成 N 项」，列表按天分组（周一 ~ 周日，
// 只显示有完成记录的天），整周为空显示空态。
// 数据只经 lib/db 查询：listCompletedBetween（completedAt ∈ [from, to)，含头不含尾）；
// 项目名用 getProject 按当前列表出现过的项目单独映射（不改 listProjects「仅未归档」语义）。
// 任务行复用 TaskList 只读形态（不传 onEdit / onComplete；completedAt 时间不单列，日期分组已表达）。
// 周切换用纯链接（<Link href="/review?week=…">），保持 Server Component 渲染，不引入客户端状态；
// 未登录访问由 middleware 全站拦截（docs/01-architecture.md「认证与访问控制」）。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。

import type { Metadata } from "next";
import Link from "next/link";

import type { TaskListItem } from "@/components/task-list";
import { TaskList } from "@/components/task-list";
import { formatLocalDate } from "@/components/today-form";
import { getProject, type ProjectRecord } from "@/lib/db/projects";
import { listCompletedBetween, type TaskRecord } from "@/lib/db/tasks";
import { parseWeekDate, shiftWeek, weekRange } from "@/lib/domain/review";
import { startOfDay } from "@/lib/domain/task";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "回顾 · 个人工作台",
};

/** 按天分组标题里的星期文案（getDay(): 0 = 周日）。 */
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 周切换链接的共同样式；当前周用 aria-current 标记。 */
const NAV_LINK_CLASS =
  "rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-sm text-neutral-600 outline-none hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";

/** 把任务行快照裁剪成展示组件需要的字段（组件不接触数据库类型），附所属项目名/颜色。 */
function toListItem(task: TaskRecord, projectById: ReadonlyMap<string, ProjectRecord>): TaskListItem {
  const project = task.projectId ? projectById.get(task.projectId) : undefined;
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    projectId: task.projectId,
    tags: task.tags,
    projectName: project?.name,
    projectColor: project?.color ?? null,
  };
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const now = new Date();
  const thisWeek = weekRange(now);
  // ?week=YYYY-MM-DD 缺失或非法时回退本周（docs/02-acceptance.md「周回顾验收」）。
  const anchor = parseWeekDate(week) ?? now;
  const range = weekRange(anchor);

  const tasks = await listCompletedBetween(range.from, range.to);

  // 项目名映射：只补当前列表里出现过的项目（复用 getProject，已归档项目同样可显示）。
  const projectIds = [
    ...new Set(tasks.flatMap((task) => (task.projectId ? [task.projectId] : []))),
  ];
  const projects = await Promise.all(projectIds.map((id) => getProject(id)));
  const projectById = new Map<string, ProjectRecord>();
  for (const project of projects) {
    if (project) projectById.set(project.id, project);
  }

  // 按天分组：周一 ~ 周日逐天建桶（不筛状态、不筛项目，完成即完成），
  // 无完成任务的天不显示分组；空整周走空态。
  const dayGroups = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(range.from);
    date.setDate(date.getDate() + offset);
    return { date, tasks: [] as TaskRecord[] };
  });
  const groupIndexByDay = new Map<string, number>(
    dayGroups.map((group, index) => [formatLocalDate(group.date), index]),
  );
  for (const task of tasks) {
    if (!task.completedAt) continue; // 区间查询已过滤，防御空值
    const dayKey = formatLocalDate(startOfDay(task.completedAt));
    const index = groupIndexByDay.get(dayKey);
    if (index !== undefined) dayGroups[index].tasks.push(task);
  }
  const groupsWithTasks = dayGroups.filter((group) => group.tasks.length > 0);

  const isCurrentWeek = range.from.getTime() === thisWeek.from.getTime();
  // 周区间标题：周一 ~ 周日（from + 6 天；shiftWeek 是按整周平移，这里只前进 6 天）。
  const weekEnd = new Date(range.from);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekLabel = `${formatLocalDate(range.from)} ~ ${formatLocalDate(weekEnd)}`;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-neutral-900">回顾</h1>
        <span className="text-sm tabular-nums text-neutral-500">{weekLabel}</span>
      </div>

      {/* 周切换：纯链接驱动查询参数，Server Component 直接渲染（无客户端周状态）。 */}
      <nav aria-label="周切换" className="mt-4 flex items-center gap-2">
        <Link href={`/review?week=${formatLocalDate(shiftWeek(range.from, -1))}`} className={NAV_LINK_CLASS}>
          ← 上一周
        </Link>
        <Link
          href="/review"
          aria-current={isCurrentWeek ? "page" : undefined}
          className={
            isCurrentWeek
              ? `${NAV_LINK_CLASS} font-semibold text-neutral-900`
              : NAV_LINK_CLASS
          }
        >
          本周
        </Link>
        <Link href={`/review?week=${formatLocalDate(shiftWeek(range.from, 1))}`} className={NAV_LINK_CLASS}>
          下一周 →
        </Link>
      </nav>

      {/* 摘要数字 = 按天分组的任务行数之和（docs/02-acceptance.md「周回顾验收」）。 */}
      <p className="mt-4 text-sm text-neutral-600">
        {isCurrentWeek ? "本周" : "当周"}完成{' '}
        <span className="font-semibold tabular-nums text-neutral-900">{tasks.length}</span> 项
      </p>

      {tasks.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-medium text-neutral-900">本周还没有完成的任务</p>
          <p className="mt-2 text-sm text-neutral-500">
            在今日或看板视图完成任务后，会按天显示在这里。
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {groupsWithTasks.map((group) => (
            <section key={formatLocalDate(group.date)}>
              <h2 className="flex items-baseline gap-2 text-sm font-semibold text-neutral-900">
                {formatLocalDate(group.date)}
                <span className="text-xs font-normal text-neutral-400">
                  {WEEKDAY_LABELS[group.date.getDay()]}
                </span>
                <span className="text-xs font-normal tabular-nums text-neutral-400">
                  {group.tasks.length}
                </span>
              </h2>
              <div className="mt-3">
                <TaskList tasks={group.tasks.map((task) => toListItem(task, projectById))} />
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
