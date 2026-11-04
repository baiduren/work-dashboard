// 看板视图首页（docs/00-product-brief.md「核心场景 4 看板」、Issue #31、Issue #51）：
// Server Component 按 lib/db 的 listTasks("board", filters) 查询 todo / doing / done 三组
// （组内按 orderIndex），展示与交互交给 components/kanban-board（dnd-kit 拖拽）。
// 筛选栏（Issue #51）：q / priority / tagId 写入 URL searchParams，三列各自过滤；
// 筛选结果全空时显示「无匹配任务」（未筛选时的空列行为保持不变）。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。
import type { Metadata } from "next";

import { KanbanBoard } from "@/components/kanban-board";
import { isOverdue, type KanbanCardData } from "@/components/kanban-form";
import { TaskFilters } from "@/components/task-filters";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";
import { tagExists } from "@/lib/db/tags";
import { hasActiveFilters, readPageTaskFilters, type FilterParamValue } from "@/lib/domain/task-filter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "看板 · 个人工作台",
};

/** 把任务行快照裁剪成看板卡片需要的字段（组件不接触数据库类型，与 app/page.tsx 同一约定）。 */
function toCard(task: TaskRecord, now: Date): KanbanCardData {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    dueDate: task.dueDate,
    overdue: isOverdue(task.dueDate, now),
  };
}

export default async function BoardPage({
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
  // 三列共用同一个 now，避免渲染中途跨天导致逾期判断不一致（与今日视图同一做法）。
  const now = new Date();
  const board = await listTasks("board", filters);
  const total = board.todo.length + board.doing.length + board.done.length;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <h1 className="text-xl font-semibold text-neutral-900">看板</h1>
      <TaskFilters />
      {filtersActive && total === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-medium text-neutral-900">无匹配任务</p>
          <p className="mt-2 text-sm text-neutral-500">
            换个关键词或调整筛选条件，也可以点「清除筛选」查看全部任务。
          </p>
        </div>
      ) : (
        <KanbanBoard
          columns={{
            todo: board.todo.map((task) => toCard(task, now)),
            doing: board.doing.map((task) => toCard(task, now)),
            done: board.done.map((task) => toCard(task, now)),
          }}
        />
      )}
    </main>
  );
}
