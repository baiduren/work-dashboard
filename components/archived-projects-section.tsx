"use client";

// 「已归档」折叠区（Issue #43）：项目列表底部的默认收起区块。
// - 标题「已归档（N）」，点击展开 / 收起（aria-expanded，无新增依赖，原生控件）；
// - 展开后显示归档项目卡片：只读（名称 + 各状态任务计数，不可点击进入详情，
//   不可改名 / 改色——归档项目只读），每张卡带「恢复」按钮；
// - 恢复 → PATCH /api/projects/:id { archived: false }，成功后 router.refresh()：
//   项目回到主列表，任务归属关系不变；失败显示紧凑错误文案。
// 组件不直接访问数据库：归档项目数据由服务端组件经 listArchivedProjects 查询后传入。

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ColorDot } from "@/components/color-dot";
import { apiErrorMessage } from "@/components/today-form";

/** 归档项目卡片数据（服务端 ProjectWithCounts 的展示子集，组件不接触数据库类型）。 */
export interface ArchivedProjectItem {
  id: string;
  name: string;
  color: string | null;
  counts: { todo: number; doing: number; done: number; total: number };
}

export function ArchivedProjectsSection({ projects }: { projects: ArchivedProjectItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (projects.length === 0) return null;

  async function handleRestore(projectId: string) {
    if (restoringId !== null) return;
    setRestoringId(projectId);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      setError(await apiErrorMessage(response, "恢复失败，请稍后再试"));
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <section aria-label="已归档项目" className="mt-8">
      <button
        type="button"
        data-testid="archived-projects-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-sm font-medium text-neutral-500 outline-none hover:text-neutral-900 focus-visible:underline"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 2.5 8 6l-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        已归档（{projects.length}）
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {projects.map((project) => (
            <div
              key={project.id}
              data-testid="archived-project-card"
              className="rounded-xl border border-neutral-200 bg-white px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <ColorDot color={project.color} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-500">
                  {project.name}
                </span>
                <button
                  type="button"
                  data-testid="restore-project-button"
                  onClick={() => void handleRestore(project.id)}
                  disabled={restoringId !== null}
                  aria-label={`恢复项目 ${project.name}`}
                  className="shrink-0 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 outline-none hover:bg-neutral-100 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {restoringId === project.id ? "恢复中…" : "恢复"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-neutral-400">
                <span>待办 {project.counts.todo}</span>
                <span>进行中 {project.counts.doing}</span>
                <span>完成 {project.counts.done}</span>
                <span>共 {project.counts.total}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
