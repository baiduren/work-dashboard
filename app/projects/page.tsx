// 项目列表页（docs/00-product-brief.md「核心场景：项目」「三种视图」、Issue #27、Issue #43）：
// 展示未归档项目卡片（颜色圆点 + 名称 + 各状态任务数），并提供新建项目表单
// （名称必填 + 固定 6 色选择）。数据只经 lib/db 的 listProjects / listArchivedProjects
// 查询（不直接调用 Prisma client、不发 HTTP）；写操作由交互组件调用现有 HTTP API 后
// router.refresh()。卡片右上角常显「归档」入口（归档后从主列表消失）；列表底部为
// 默认收起的「已归档」折叠区（展开只读展示 + 可恢复）。未归档项目为空时显示空态。
// force-dynamic 保证按请求渲染，构建期不访问数据库。

import type { Metadata } from "next";
import Link from "next/link";

import { ArchivedProjectsSection } from "@/components/archived-projects-section";
import { ColorDot } from "@/components/color-dot";
import { CreateProjectForm } from "@/components/create-project-form";
import { ProjectCardActions } from "@/components/project-card-actions";
import { listArchivedProjects, listProjects, type ProjectWithCounts } from "@/lib/db/projects";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "项目 · 个人工作台",
};

function ProjectCard({ project }: { project: ProjectWithCounts }) {
  return (
    // 边框与 hover 反馈放在卡片容器上；「归档」按钮在 Link 之外（不嵌套进链接）。
    <div className="flex rounded-xl border border-neutral-200 bg-white transition-colors hover:border-neutral-300 focus-within:border-neutral-900">
      <Link
        href={`/projects/${project.id}`}
        className="block min-w-0 flex-1 rounded-xl px-4 py-3 outline-none"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ColorDot color={project.color} />
          <span className="min-w-0 truncate text-sm font-medium text-neutral-900">
            {project.name}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-neutral-500">
          <span>待办 {project.counts.todo}</span>
          <span>进行中 {project.counts.doing}</span>
          <span>完成 {project.counts.done}</span>
          <span className="text-neutral-400">共 {project.counts.total}</span>
        </div>
      </Link>
      <ProjectCardActions projectId={project.id} />
    </div>
  );
}

export default async function ProjectsPage() {
  const [projects, archived] = await Promise.all([listProjects(), listArchivedProjects()]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-neutral-900">项目</h1>
        <span className="text-sm tabular-nums text-neutral-500">{projects.length} 个</span>
      </div>

      <CreateProjectForm />

      {projects.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-medium text-neutral-900">还没有项目</p>
          <p className="mt-2 text-sm text-neutral-500">
            在上方输入名称并回车，创建第一个项目。
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      <ArchivedProjectsSection projects={archived} />
    </main>
  );
}
