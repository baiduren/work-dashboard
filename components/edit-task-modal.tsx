"use client";

// 编辑任务弹层（Issue #25；Issue #27 增加「所属项目」下拉；Issue #39 增加「标签」区块）：
// 原生 <dialog> 实现（无新增依赖，docs/adr/0003-ui-components.md）。
// - 可编辑：标题、备注、优先级、截止日期（<input type="date">，可清空）、所属项目
//   （下拉数据来自 GET /api/projects，含「无项目」项；清空则保存 projectId=null）、
//   标签（复选列表 + 「新建标签」内联输入，数据来自 GET /api/tags；保存任务时随
//   PATCH tagIds 一次提交全量勾选集合；标签列表加载失败时不发送 tagIds，
//   服务端不动既有绑定，避免误清空）；
// - 打开时并行拉取项目与标签列表；失败可重开弹层重试，不阻塞其他字段编辑；
// - 打开时预填当前值；showModal 提供模态焦点与 Esc 关闭，关闭后焦点回到触发元素；
// - 保存 → PATCH /api/tasks/:id；标题经 lib/domain parseTitle、新建标签名经 parseTagName
//   做客户端校验（复用取值规则，不重复实现服务端校验）；服务端 400 时在弹层内显示
//   { error } 文案且不关闭弹层；
// - 保存成功回调 onSaved（父级借此 router.refresh() 同步任务行/项目计数），取消 / Esc 不产生请求。
// 父级按 key=任务 id 渲染本组件，切换编辑对象时状态自然重置。

import { useEffect, useRef, useState, type FormEvent } from "react";

import { ColorDot } from "@/components/color-dot";
import { PRIORITY_STYLES, type TaskListItem, type TaskTagItem } from "@/components/task-list";
import { apiErrorMessage, dueDateInputToPatch, formatLocalDate } from "@/components/today-form";
import { PROJECT_COLORS } from "@/lib/domain/project";
import { parseTagName } from "@/lib/domain/tag";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, parseTitle, TaskValidationError } from "@/lib/domain/task";

const FALLBACK_PRIORITY_LABEL = "中";

/** 「所属项目」下拉的选项（来自 GET /api/projects；不含计数等展示字段）。 */
interface ProjectOption {
  id: string;
  name: string;
}

/** 下拉第一项：值 "" 表示「无项目」，保存时映射为 projectId=null。 */
const NO_PROJECT_VALUE = "";

export function EditTaskModal({
  task,
  onClose,
  onSaved,
}: {
  task: TaskListItem;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [priority, setPriority] = useState(() =>
    (TASK_PRIORITIES as readonly string[]).includes(task.priority)
      ? task.priority
      : DEFAULT_TASK_PRIORITY,
  );
  const [dueDate, setDueDate] = useState(task.dueDate ? formatLocalDate(task.dueDate) : "");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(task.projectId ?? NO_PROJECT_VALUE);
  const [tags, setTags] = useState<TaskTagItem[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<ReadonlySet<string>>(() => {
    return new Set((task.tags ?? []).map((tag) => tag.id));
  });
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [tagFormError, setTagFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开弹层；关闭时把焦点还给触发元素（Esc 原生归还，保存路径在这里补偿）。
  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (document.activeElement === document.body) {
        previouslyFocused?.focus();
      }
    };
  }, []);

  // 拉取项目列表（打开弹层时一次）：失败时下拉只剩「无项目」，并给出可重试的提示文案。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) {
          if (!cancelled) {
            setProjectsError(await apiErrorMessage(response, "项目列表加载失败，保存前可重开弹层重试"));
          }
          return;
        }
        const data: unknown = await response.json();
        if (cancelled || !Array.isArray(data)) return;
        setProjects(
          data
            .filter(
              (item): item is { id: string; name: string } =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as { id?: unknown }).id === "string" &&
                typeof (item as { name?: unknown }).name === "string",
            )
            .map((item) => ({ id: item.id, name: item.name })),
        );
      } catch {
        if (!cancelled) setProjectsError("项目列表加载失败，保存前可重开弹层重试");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 拉取标签列表（打开弹层时一次，与项目列表并行）：失败时勾选列表不可用、
  // 给出可重试的提示文案；此时保存不发送 tagIds（服务端不动既有绑定，避免误清空）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/tags");
        if (!response.ok) {
          if (!cancelled) {
            setTagsError(await apiErrorMessage(response, "标签列表加载失败，保存前可重开弹层重试"));
          }
          return;
        }
        const data: unknown = await response.json();
        if (cancelled || !Array.isArray(data)) return;
        setTags(
          data.filter(
            (item): item is TaskTagItem =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as { id?: unknown }).id === "string" &&
              typeof (item as { name?: unknown }).name === "string",
          ),
        );
      } catch {
        if (!cancelled) setTagsError("标签列表加载失败，保存前可重开弹层重试");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }

  /** 新建标签：客户端先经 parseTagName 校验，成功后加入列表并勾选到当前任务。 */
  async function handleCreateTag() {
    if (creatingTag || saving) return;
    let name: string;
    try {
      name = parseTagName(newTagName);
    } catch (validationError) {
      setTagFormError(
        validationError instanceof TaskValidationError
          ? validationError.message
          : "标签名不能为空",
      );
      return;
    }
    setCreatingTag(true);
    setTagFormError(null);
    try {
      const response = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: newTagColor }),
      });
      if (response.ok) {
        const created: unknown = await response.json();
        if (
          typeof created === "object" &&
          created !== null &&
          typeof (created as { id?: unknown }).id === "string"
        ) {
          const tag = created as TaskTagItem;
          setTags((prev) => {
            const next = [...prev, tag];
            next.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            return next;
          });
          setSelectedTagIds((prev) => new Set(prev).add(tag.id));
          setNewTagName("");
          setNewTagColor(null);
        }
      } else {
        // 服务端 400（重名「标签名已存在」等）：在新建行下方显示文案。
        setTagFormError(await apiErrorMessage(response, "创建标签失败，请稍后再试"));
      }
    } catch {
      setTagFormError("网络异常，请稍后再试");
    } finally {
      setCreatingTag(false);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    // 客户端标题校验：复用 lib/domain 取值规则（空 / 纯空白 → 阻止提交）。
    try {
      parseTitle(title);
    } catch (validationError) {
      setError(
        validationError instanceof TaskValidationError
          ? validationError.message
          : "标题不能为空",
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // tagIds 只在标签列表加载成功时发送：勾选集合是「全量替换」语义，
      // 列表加载失败时勾选状态不完整，发送会误清空既有绑定（此时服务端不动标签）。
      const payload: Record<string, unknown> = {
        title: title.trim(),
        notes: notes.trim() === "" ? null : notes,
        priority,
        dueDate: dueDateInputToPatch(dueDate),
        projectId: projectId === NO_PROJECT_VALUE ? null : projectId,
      };
      if (tagsError === null) {
        payload.tagIds = [...selectedTagIds];
      }
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        dialogRef.current?.close();
        onSaved?.();
        onClose();
        return;
      }
      // 服务端 400（或其他失败）：显示 { error } 文案，弹层保持打开。
      setError(await apiErrorMessage(response, "保存失败，请稍后再试"));
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="edit-task-heading"
      className="max-h-[85vh] w-[min(92vw,28rem)] overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl backdrop:bg-black/30"
    >
      <h2 id="edit-task-heading" className="text-base font-semibold text-neutral-900">
        编辑任务
      </h2>
      <form className="mt-4 space-y-4" onSubmit={handleSave}>
        <div>
          <label htmlFor="edit-task-title" className="block text-sm font-medium text-neutral-700">
            标题
          </label>
          <input
            id="edit-task-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={saving}
            className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 disabled:opacity-60"
          />
        </div>
        <div>
          <label htmlFor="edit-task-notes" className="block text-sm font-medium text-neutral-700">
            备注
          </label>
          <textarea
            id="edit-task-notes"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={saving}
            className="mt-1 w-full resize-y rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 disabled:opacity-60"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label htmlFor="edit-task-priority" className="block text-sm font-medium text-neutral-700">
              优先级
            </label>
            <select
              id="edit-task-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              disabled={saving}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 disabled:opacity-60"
            >
              {TASK_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_STYLES[value]?.label ?? FALLBACK_PRIORITY_LABEL}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="edit-task-due-date" className="block text-sm font-medium text-neutral-700">
              截止日期
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="edit-task-due-date"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                disabled={saving}
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 disabled:opacity-60"
              />
              {dueDate !== "" ? (
                <button
                  type="button"
                  onClick={() => setDueDate("")}
                  disabled={saving}
                  aria-label="清除截止日期"
                  className="shrink-0 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-60"
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div>
          <label htmlFor="edit-task-project" className="block text-sm font-medium text-neutral-700">
            所属项目
          </label>
          <select
            id="edit-task-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={saving}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-900 disabled:opacity-60"
          >
            <option value={NO_PROJECT_VALUE}>无项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {projectsError ? (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {projectsError}
            </p>
          ) : null}
        </div>
        <fieldset>
          <legend className="block text-sm font-medium text-neutral-700">标签</legend>
          {tagsError ? (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {tagsError}
            </p>
          ) : (
            <>
              {tags.length > 0 ? (
                <div className="mt-1 max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-neutral-200 p-2">
                  {tags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTagIds.has(tag.id)}
                        onChange={() => toggleTag(tag.id)}
                        disabled={saving}
                        className="h-4 w-4 shrink-0 accent-neutral-900"
                      />
                      <ColorDot color={tag.color} />
                      <span className="min-w-0 truncate">{tag.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-neutral-400">暂无标签，可在下方新建并勾选</p>
              )}
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(event) => setNewTagName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleCreateTag();
                    }
                  }}
                  disabled={saving || creatingTag}
                  maxLength={24}
                  placeholder="新建标签（可选颜色后添加）"
                  aria-label="新建标签名称"
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateTag()}
                  disabled={saving || creatingTag || newTagName.trim() === ""}
                  className="shrink-0 rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {creatingTag ? "添加中…" : "添加"}
                </button>
              </div>
              <div className="mt-2 flex items-center gap-1.5" role="group" aria-label="新建标签颜色">
                <button
                  type="button"
                  onClick={() => setNewTagColor(null)}
                  disabled={saving || creatingTag}
                  aria-pressed={newTagColor === null}
                  aria-label="无颜色"
                  title="无颜色"
                  className={`flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                    newTagColor === null ? "ring-2 ring-neutral-900 ring-offset-1" : ""
                  }`}
                >
                  <span aria-hidden="true" className="block h-3 w-3 rounded-full bg-neutral-300" />
                </button>
                {PROJECT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewTagColor(color)}
                    disabled={saving || creatingTag}
                    aria-pressed={newTagColor === color}
                    aria-label={`颜色 ${color}`}
                    title={color}
                    style={{ backgroundColor: color }}
                    className={`h-6 w-6 rounded-full border border-black/10 disabled:cursor-not-allowed disabled:opacity-60 ${
                      newTagColor === color ? "ring-2 ring-neutral-900 ring-offset-1" : ""
                    }`}
                  />
                ))}
              </div>
              {tagFormError ? (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {tagFormError}
                </p>
              ) : null}
            </>
          )}
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
