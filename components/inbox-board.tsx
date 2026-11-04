"use client";

// 收件箱的交互容器（Issue #50，docs/00-product-brief.md「核心场景 2 收件箱」）：
// 持有行隐藏、快捷归类、完成/撤销、编辑弹层与提示的客户端状态。
// 数据获取仍由 Server Component 完成（app/inbox/page.tsx 查询 listTasks("undated") 后传入）；
// 归类 / 完成 / 撤销全部走现有 PATCH /api/tasks/:id（不新增端点），成功后 router.refresh()
// 让 Server Component 重新渲染：设了日期的任务从收件箱消失，并出现在今日 / 逾期视图。
// - 快捷归类：今天 / 明天 / 下周一三档，只改 dueDate（浏览器本地日期，与快速添加同一约定）；
//   「更多…」打开复用现有 EditTaskModal，可设自定义日期 / 归属项目 / 优先级 / 删除；
// - 完成：PATCH status=done 成功后立即隐藏该行并弹出「已标记完成 · 撤销」提示（6 秒消失），
//   与今日视图行为一致；撤销恢复完成前的状态；
// - 已完成任务的查询语义不变：done 不出现在 undated 视图（lib/db listTasks）。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { EditTaskModal } from "@/components/edit-task-modal";
import { TaskList, type QuickClassifyOption, type TaskListItem } from "@/components/task-list";
import { apiErrorMessage, formatQuickClassifyDate } from "@/components/today-form";
import { parseStatus, type TaskStatus } from "@/lib/domain/task";

/** 提示浮层：completed 带「撤销」；message 用于归类成功 / 失败文案。 */
type ToastState =
  | { kind: "completed"; task: TaskListItem; previousStatus: TaskStatus }
  | { kind: "message"; message: string };

const TOAST_AUTO_DISMISS_MS = 6000;

/** 行内快捷归类的三档日期（Issue #50）；每次渲染按浏览器本地日期计算，跨天后点击仍是正确的日期。 */
function buildQuickClassifyOptions(): QuickClassifyOption[] {
  const now = new Date();
  return [
    { label: "今天", dueDate: formatQuickClassifyDate("today", now) },
    { label: "明天", dueDate: formatQuickClassifyDate("tomorrow", now) },
    { label: "下周一", dueDate: formatQuickClassifyDate("nextMonday", now) },
  ];
}

export function InboxBoard({ tasks }: { tasks: readonly TaskListItem[] }) {
  const router = useRouter();
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskListItem | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undoing, setUndoing] = useState(false);

  // 提示自动消失；每条新提示重置计时。
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 一键归类（Issue #50）：只改 dueDate，成功后立即隐藏该行并刷新服务端数据。 */
  async function handleClassify(task: TaskListItem, dueDate: string) {
    if (classifyingId) return;
    setClassifyingId(task.id);
    setToast(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate }),
      });
      if (response.ok) {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.add(task.id);
          return next;
        });
        setToast({ kind: "message", message: `已归类到 ${dueDate}` });
        router.refresh();
      } else {
        setToast({
          kind: "message",
          message: await apiErrorMessage(response, "归类失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "message", message: "网络异常，请稍后再试" });
    } finally {
      setClassifyingId(null);
    }
  }

  /** 完成（与今日视图行为一致）：PATCH status=done，隐藏该行并给出可撤销提示。 */
  async function handleComplete(task: TaskListItem) {
    if (completingId) return;
    setCompletingId(task.id);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (response.ok) {
        // 撤销时恢复完成前的状态（todo/doing）；未知取值回退 todo（parseStatus 校验）。
        let previousStatus: TaskStatus = "todo";
        try {
          previousStatus = parseStatus(task.status);
        } catch {
          // 理论上不出现（收件箱只含未完成任务），回退 todo 保证可撤销。
        }
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.add(task.id);
          return next;
        });
        setToast({ kind: "completed", task, previousStatus });
        router.refresh();
      } else {
        setToast({
          kind: "message",
          message: await apiErrorMessage(response, "标记完成失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "message", message: "网络异常，请稍后再试" });
    } finally {
      setCompletingId(null);
    }
  }

  /** 撤销刚才的完成：PATCH 回完成前的状态，取消隐藏并刷新。 */
  async function handleUndo() {
    if (toast?.kind !== "completed" || undoing) return;
    const { task, previousStatus } = toast;
    setUndoing(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: previousStatus }),
      });
      if (response.ok) {
        setHiddenIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
        setToast(null);
        router.refresh();
      } else {
        setToast({
          kind: "message",
          message: await apiErrorMessage(response, "撤销失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "message", message: "网络异常，请稍后再试" });
    } finally {
      setUndoing(false);
    }
  }

  const visibleTasks = tasks.filter((task) => !hiddenIds.has(task.id));
  const classifyOptions = buildQuickClassifyOptions();

  return (
    <div className="mt-4">
      <TaskList
        tasks={visibleTasks}
        completingId={completingId}
        onEdit={setEditing}
        onComplete={handleComplete}
        quickClassifyOptions={classifyOptions}
        onQuickClassify={handleClassify}
        classifyingId={classifyingId}
      />

      {editing ? (
        <EditTaskModal
          key={editing.id}
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => router.refresh()}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg"
        >
          {toast.kind === "completed" ? (
            <span className="flex items-center gap-2">
              <span className="max-w-[16rem] truncate">已标记完成「{toast.task.title}」</span>
              <span aria-hidden="true" className="text-neutral-500">
                ·
              </span>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoing}
                className="font-medium underline underline-offset-2 hover:text-neutral-300 disabled:opacity-60"
              >
                {undoing ? "撤销中…" : "撤销"}
              </button>
            </span>
          ) : (
            <span>{toast.message}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
