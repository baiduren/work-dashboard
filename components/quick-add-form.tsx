"use client";

// 快速添加表单（Issue #25、docs/00-product-brief.md「快速添加：键盘优先」）：
// 输入标题 + 回车（或点「添加」）创建任务，默认今天到期、优先级 medium。
// 仅标题必填：空 / 纯空白输入直接忽略，不发请求；
// 提交中禁用输入与按钮防重复提交；失败保留输入并显示服务端 { error } 文案；
// 成功清空输入并 router.refresh() 刷新 Server Component，任务出现在「今天到期」组。
// payload 构造复用 components/today-form.ts 的纯逻辑（tests/today-form.test.ts 覆盖）。

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage, buildQuickAddPayload } from "@/components/today-form";

export function QuickAddForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    // 空 / 纯空白输入：忽略，不发请求（也不清空已有错误提示之外的状态）。
    const payload = buildQuickAddPayload(title, new Date());
    if (!payload) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setTitle("");
        router.refresh();
      } else {
        // 服务端校验失败（400 等）或未登录（401）：保留输入，显示服务端 { error } 文案。
        setError(await apiErrorMessage(response, "添加失败，请稍后再试"));
      }
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4" aria-label="快速添加任务">
      <div className="flex gap-2">
        <input
          type="text"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={submitting}
          aria-label="任务标题"
          placeholder="添加任务，回车确认（默认今天到期）"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={submitting}
          className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "添加中…" : "添加"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </form>
  );
}
