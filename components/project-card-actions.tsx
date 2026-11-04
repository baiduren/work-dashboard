"use client";

// 项目卡片「归档」入口（Issue #43）：neutral 风格轻量文字按钮，常显于卡片右上角。
// 点击 → PATCH /api/projects/:id { archived: true }，成功后 router.refresh()——
// 卡片从主列表消失并出现在列表底部「已归档」折叠区（服务器组件重新渲染）。
// 失败（400 / 401 / 网络异常）时按钮旁显示紧凑错误文案（title 给出完整信息），
// 卡片留在主列表。按钮置于卡片 Link 之外（按钮不嵌进链接，保持合法 HTML）。

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage } from "@/components/today-form";

export function ProjectCardActions({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleArchive() {
    if (archiving) return;
    setArchiving(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      setError(await apiErrorMessage(response, "归档失败，请稍后再试"));
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="flex items-start gap-2 py-3 pr-3">
      {error ? (
        <span
          role="alert"
          title={error}
          className="max-w-28 truncate pt-1.5 text-xs text-red-600"
        >
          {error}
        </span>
      ) : null}
      <button
        type="button"
        data-testid="archive-project-button"
        onClick={() => void handleArchive()}
        disabled={archiving}
        aria-label="归档项目"
        className="shrink-0 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-500 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {archiving ? "归档中…" : "归档"}
      </button>
    </div>
  );
}
