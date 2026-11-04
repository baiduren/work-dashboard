// 收件箱视图（Issue #50；docs/00-product-brief.md「核心场景 2 收件箱」：随手记录、稍后归类）：
// 集中展示全部无日期未完成任务，提供「不设日期」的快速添加与一键归类（设为今天 / 明天 /
// 下周一，或经编辑弹层设自定义日期 / 归属项目 / 优先级 / 删除），行内可直接勾选完成。
// 数据复用今日视图「待安排」组的同一查询 listTasks("undated", { now })——不新建查询语义，
// 保证两个入口展示的任务集合永远一致；今日视图的「待安排」组保留不变（双入口并存）。
// 视图 / 归类 / 完成写操作全部复用现有 HTTP API（POST /api/tasks、PATCH /api/tasks/:id），
// 零 schema / API 改动；交互组件（Client Component）成功后 router.refresh() 回到这里刷新。
// force-dynamic 保证按请求渲染，构建期不访问数据库（docs/02-acceptance.md）。

import type { Metadata } from "next";

import { InboxBoard } from "@/components/inbox-board";
import { InboxQuickAdd } from "@/components/inbox-quick-add";
import type { TaskListItem } from "@/components/task-list";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收件箱 · 个人工作台",
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

export default async function InboxPage() {
  const now = new Date();
  const tasks = await listTasks("undated", { now });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-neutral-900">收件箱</h1>
        <span className="text-sm tabular-nums text-neutral-500">{tasks.length} 项待归类</span>
      </div>

      <InboxQuickAdd />

      {tasks.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-medium text-neutral-900">收件箱清空了，随手记点什么？</p>
          <p className="mt-2 text-sm text-neutral-500">
            在上方输入标题并回车，任务会先收进这里，之后再设日期或归到项目。
          </p>
        </div>
      ) : (
        <InboxBoard tasks={tasks.map(toListItem)} />
      )}
    </main>
  );
}
