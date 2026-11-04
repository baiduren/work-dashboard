// 项目详情页（Issue #27、Issue #39）：项目名/颜色 + 该项目全部状态的任务列表（只读，
// 任务行带标签徽标）。数据只经 lib/db 查询：getProject + listTasks("project", { projectId })
// （project 视图含全部状态：todo → doing → done，组内按 orderIndex，见 lib/db/tasks）。
// 列表复用 TaskList 的只读形态：不传 onEdit / onComplete，行不可编辑、无「完成」按钮，
// 并以状态徽标区分进行中 / 已完成任务。项目不存在 → notFound()（404）。
// force-dynamic 保证按请求渲染，构建期不访问数据库。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ColorDot } from "@/components/color-dot";
import type { TaskListItem } from "@/components/task-list";
import { TaskList } from "@/components/task-list";
import { getProject, type ProjectRecord } from "@/lib/db/projects";
import { listTasks, type TaskRecord } from "@/lib/db/tasks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "项目 · 个人工作台",
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

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project: ProjectRecord | null = await getProject(id);
  if (!project) {
    notFound();
  }
  const tasks = await listTasks("project", { projectId: id });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <Link
        href="/projects"
        className="text-sm text-neutral-500 outline-none hover:text-neutral-900 focus-visible:underline"
      >
        ← 返回项目
      </Link>
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <ColorDot color={project.color} />
        <h1 className="min-w-0 truncate text-xl font-semibold text-neutral-900">
          {project.name}
        </h1>
        <span className="shrink-0 text-sm tabular-nums text-neutral-500">
          {tasks.length} 个任务
        </span>
      </div>

      <div className="mt-6">
        {tasks.length > 0 ? (
          <TaskList tasks={tasks.map(toListItem)} showStatus />
        ) : (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
            <p className="text-base font-medium text-neutral-900">该项目还没有任务</p>
            <p className="mt-2 text-sm text-neutral-500">
              在今日视图编辑任务时选择「所属项目」，任务会出现在这里。
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
