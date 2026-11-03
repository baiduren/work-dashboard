// 看板视图首页（docs/00-product-brief.md「核心场景 4 看板」、Issue #31）：
// Server Component 按 lib/db 的 listTasks("board") 查询 todo / doing / done 三组
// （组内按 orderIndex），展示与交互交给 components/kanban-board（dnd-kit 拖拽）。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。
import type { Metadata } from "next";

import { KanbanBoard } from "@/components/kanban-board";
import { isOverdue, type KanbanCardData } from "@/components/kanban-form";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";

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

export default async function BoardPage() {
  // 三列共用同一个 now，避免渲染中途跨天导致逾期判断不一致（与今日视图同一做法）。
  const now = new Date();
  const board = await listTasks("board");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <h1 className="text-xl font-semibold text-neutral-900">看板</h1>
      <KanbanBoard
        columns={{
          todo: board.todo.map((task) => toCard(task, now)),
          doing: board.doing.map((task) => toCard(task, now)),
          done: board.done.map((task) => toCard(task, now)),
        }}
      />
    </main>
  );
}
