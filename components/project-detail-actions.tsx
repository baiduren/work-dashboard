"use client";

// 项目详情页头部的「归档 / 删除」操作（Issue #43），复用编辑弹层（Issue #41）的
// 内联两段式确认交互模式，不用 window.confirm：
// - 归档（未归档项目）：PATCH { archived: true }，成功后跳回 /projects；
//   已归档项目改为显示「恢复」（PATCH { archived: false }，成功后原地刷新，
//   恢复后本组件随服务端重渲染切回归档 / 删除形态）；
// - 删除：第一次点击进入内联确认态「确认删除？」（旁有「再想想」撤销，并浮出提示
//   「项目下的任务会保留，但不再归属任何项目」）；点击其他区域 / 5 秒无操作超时复位；
//   再次点击才发 DELETE /api/projects/:id；204 与 404（另一端已删）都跳回 /projects，
//   其余失败显示固定错误文案、确认态复位。其下任务的 projectId 由服务端 SetNull 置空。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage } from "@/components/today-form";

/** 删除确认态的超时：与编辑弹层同一模式，5 秒无操作自动复位。 */
const DELETE_CONFIRM_RESET_MS = 5000;

export function ProjectDetailActions({
  projectId,
  archived,
}: {
  projectId: string;
  archived: boolean;
}) {
  const router = useRouter();
  const actionGroupRef = useRef<HTMLDivElement>(null);
  // 任一请求进行中置为对应操作；归档 / 恢复 / 删除互斥（防并发写同一项目）。
  const [pending, setPending] = useState<"archive" | "restore" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  // 确认态超时复位：5 秒无操作回到「删除」；请求进行中不复位（结束后统一复位）。
  useEffect(() => {
    if (!confirmingDelete || busy) return;
    const timer = setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirmingDelete, busy]);

  // 确认态下点击操作区以外的地方即复位（Esc 无弹层可关，靠超时 / 点击复位兜底）。
  useEffect(() => {
    if (!confirmingDelete) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && actionGroupRef.current?.contains(target)) return;
      setConfirmingDelete(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [confirmingDelete]);

  /** 归档 / 恢复：PATCH archived；归档成功跳回 /projects，恢复成功原地刷新。 */
  async function handleToggleArchive(next: boolean) {
    if (busy) return;
    setPending(next ? "archive" : "restore");
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: next }),
      });
      if (response.ok) {
        if (next) router.push("/projects");
        else router.refresh();
        return;
      }
      setError(await apiErrorMessage(response, next ? "归档失败，请稍后再试" : "恢复失败，请稍后再试"));
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setPending(null);
    }
  }

  /**
   * 删除（内联两段式确认）：第一次点击进入确认态；再次点击才发 DELETE。
   * 204 与 404（可能另一端已删）都视为已删除，跳回 /projects；
   * 其余失败显示固定错误文案、确认态复位、项目保留。
   */
  async function handleDelete() {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setPending("delete");
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (response.ok || response.status === 404) {
        router.push("/projects");
        return;
      }
      setError(await apiErrorMessage(response, "删除失败，请稍后再试"));
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setPending(null);
      setConfirmingDelete(false);
    }
  }

  return (
    <div ref={actionGroupRef} className="relative ml-auto flex shrink-0 items-center gap-2">
      {archived ? (
        <button
          type="button"
          data-testid="restore-project-button"
          onClick={() => void handleToggleArchive(false)}
          disabled={busy}
          className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "restore" ? "恢复中…" : "恢复"}
        </button>
      ) : (
        <button
          type="button"
          data-testid="archive-project-button"
          onClick={() => void handleToggleArchive(true)}
          disabled={busy}
          className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "archive" ? "归档中…" : "归档"}
        </button>
      )}
      {confirmingDelete ? (
        <>
          <button
            type="button"
            data-testid="confirm-delete-project-button"
            onClick={() => void handleDelete()}
            disabled={busy}
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 outline-none hover:bg-red-100 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending === "delete" ? "删除中…" : "确认删除？"}
          </button>
          <button
            type="button"
            data-testid="cancel-delete-project-button"
            onClick={() => setConfirmingDelete(false)}
            disabled={busy}
            className="text-sm font-medium text-neutral-500 underline underline-offset-2 outline-none hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            再想想
          </button>
          <p
            data-testid="delete-project-hint"
            role="note"
            className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-relaxed text-neutral-600 shadow-sm"
          >
            项目下的任务会保留，但不再归属任何项目。此操作不可撤销。
          </p>
        </>
      ) : (
        <button
          type="button"
          data-testid="delete-project-button"
          onClick={() => void handleDelete()}
          disabled={busy}
          className="rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 outline-none hover:bg-red-50 focus-visible:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending === "delete" ? "删除中…" : "删除"}
        </button>
      )}
      {error ? (
        <p role="alert" className="absolute right-0 top-full z-10 mt-2 max-w-64 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
