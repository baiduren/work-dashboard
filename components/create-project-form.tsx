"use client";

// 新建项目表单（Issue #27）：名称（必填）+ 固定 6 色选择（默认色，可清除回默认）。
// - 名称校验复用 lib/domain parseProjectName（空 / 纯空白 / 超长 → 阻止提交），
//   不在前端重复实现服务端校验（docs/01-architecture.md「模块边界」）；
// - 提交 → POST /api/projects；失败保留输入并显示服务端 { error } 文案；
// - 成功清空输入、颜色回默认并 router.refresh()，新项目卡片出现在列表。

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage } from "@/components/today-form";
import {
  DEFAULT_PROJECT_COLOR,
  parseProjectName,
  PROJECT_COLORS,
} from "@/lib/domain/project";
import { TaskValidationError } from "@/lib/domain/task";

export function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 客户端名称校验：复用 lib/domain 取值规则（空 / 纯空白 / 超长 → 阻止提交）。
    try {
      parseProjectName(name);
    } catch (validationError) {
      setError(
        validationError instanceof TaskValidationError
          ? validationError.message
          : "项目名不能为空",
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      });
      if (response.ok) {
        setName("");
        setColor(DEFAULT_PROJECT_COLOR);
        router.refresh();
      } else {
        // 服务端校验失败（400 等）或未登录（401）：保留输入，显示服务端 { error } 文案。
        setError(await apiErrorMessage(response, "创建失败，请稍后再试"));
      }
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4" aria-label="新建项目">
      <div className="flex gap-2">
        <input
          type="text"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
          aria-label="项目名称"
          placeholder="新建项目，回车确认"
          maxLength={60}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={submitting}
          className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "创建中…" : "创建"}
        </button>
      </div>
      <fieldset className="mt-2 flex items-center gap-2" disabled={submitting}>
        <legend className="sr-only">项目颜色</legend>
        {PROJECT_COLORS.map((value) => {
          const selected = color === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`颜色 ${value}`}
              onClick={() => setColor(value)}
              disabled={submitting}
              className={`h-6 w-6 rounded-full border-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:opacity-60 ${
                selected ? "border-neutral-900" : "border-transparent hover:border-neutral-300"
              }`}
              style={{ backgroundColor: value }}
            />
          );
        })}
      </fieldset>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </form>
  );
}
