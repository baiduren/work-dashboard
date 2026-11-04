"use client";

// 今日视图的交互容器（Issue #25；Issue #39 增加标签徽标筛选；Issue #51 服务端筛选并存）：
// 持有编辑弹层、完成/撤销、行隐藏与标签筛选的客户端状态。
// 数据获取仍由 Server Component 完成（app/page.tsx 查询后传入分节数组）；
// 写操作全部走现有 HTTP API（PATCH /api/tasks/:id），成功后 router.refresh()
// 让 Server Component 重新渲染（docs/01-architecture.md「模块边界」）。
// - 完成：PATCH status=done 成功后立即隐藏该行并弹出「已标记完成 · 撤销」提示（6 秒自动消失）；
// - 撤销：PATCH status=完成前的状态（todo/doing），行回到原组；
// - 标签筛选（Issue #39）：「全部标签」+ 各标签下拉，选中后按当前列表内 tags
//   前端过滤，作为轻量快捷方式保留；
// - 服务端筛选（Issue #51）：q / priority / tagId 由 app/page.tsx 按 URL searchParams 查询，
//   本组件只接收 filtersActive 用于区分「该组无匹配任务」与普通空态；
// - 已完成任务的查询语义不变：done 不出现在今日视图（lib/db listTasks）。

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { EditTaskModal } from "@/components/edit-task-modal";
import { TaskList, type TaskListItem, type TaskTagItem } from "@/components/task-list";
import { apiErrorMessage } from "@/components/today-form";
import { parseStatus, type TaskStatus } from "@/lib/domain/task";

export interface TodaySectionData {
  key: "today" | "overdue" | "undated";
  heading: string;
  tasks: TaskListItem[];
  overdue: boolean;
  emptyText: string;
}

/** 完成后的浮层提示；kind=error 时复用同一位置展示失败文案。 */
type ToastState =
  | { kind: "completed"; task: TaskListItem; previousStatus: TaskStatus }
  | { kind: "error"; message: string };

const TOAST_AUTO_DISMISS_MS = 6000;

export function TodayBoard({
  sections,
  filtersActive = false,
}: {
  sections: readonly TodaySectionData[];
  /** URL 中带有 q / priority / tagId 服务端筛选（Issue #51）：空组显示「无匹配任务」文案。 */
  filtersActive?: boolean;
}) {
  const router = useRouter();
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskListItem | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undoing, setUndoing] = useState(false);
  // 标签筛选："" 表示「全部标签」；选中后按当前列表内 tags 前端过滤（Issue #39）。
  const [tagFilter, setTagFilter] = useState("");

  // 汇总当前列表里出现过的标签（按名称排序去重），作为筛选下拉的选项。
  const knownTags = useMemo<TaskTagItem[]>(() => {
    const byId = new Map<string, TaskTagItem>();
    for (const section of sections) {
      for (const task of section.tasks) {
        for (const tag of task.tags ?? []) {
          if (!byId.has(tag.id)) byId.set(tag.id, tag);
        }
      }
    }
    return [...byId.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }, [sections]);

  // 提示自动消失；每条新提示重置计时。
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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
          // 理论上不出现（今日视图只含未完成任务），回退 todo 保证可撤销。
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
          kind: "error",
          message: await apiErrorMessage(response, "标记完成失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "error", message: "网络异常，请稍后再试" });
    } finally {
      setCompletingId(null);
    }
  }

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
          kind: "error",
          message: await apiErrorMessage(response, "撤销失败，请稍后再试"),
        });
      }
    } catch {
      setToast({ kind: "error", message: "网络异常，请稍后再试" });
    } finally {
      setUndoing(false);
    }
  }

  const visibleSections = sections.map((section) => ({
    ...section,
    tasks: section.tasks.filter(
      (task) =>
        !hiddenIds.has(task.id) &&
        (tagFilter === "" || (task.tags ?? []).some((tag) => tag.id === tagFilter)),
    ),
  }));

  return (
    <div className="mt-6 space-y-8">
      {knownTags.length > 0 ? (
        <div className="flex items-center gap-2">
          <label
            htmlFor="today-tag-filter"
            className="shrink-0 text-sm font-medium text-neutral-700"
          >
            按标签筛选
          </label>
          <select
            id="today-tag-filter"
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
            aria-label="按标签筛选"
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-900"
          >
            <option value="">全部标签</option>
            {knownTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {visibleSections.map((section) => (
        <section key={section.key}>
          <h2 className="flex items-baseline gap-2 text-sm font-semibold text-neutral-900">
            {section.heading}
            <span className="text-xs font-normal tabular-nums text-neutral-400">
              {section.tasks.length}
            </span>
          </h2>
          <div className="mt-3">
            {section.tasks.length > 0 ? (
              <TaskList
                tasks={section.tasks}
                overdue={section.overdue}
                completingId={completingId}
                onEdit={setEditing}
                onComplete={handleComplete}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-sm text-neutral-400">
                {tagFilter !== ""
                  ? "该组没有带选中标签的任务"
                  : filtersActive
                    ? "该组无匹配任务"
                    : section.emptyText}
              </p>
            )}
          </div>
        </section>
      ))}

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
