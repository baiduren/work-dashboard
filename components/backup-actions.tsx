"use client";

// 导出 / 导入入口（Issue #37、docs/01-architecture.md「数据导出 / 导入」）：
// - 「导出」经 window.location.assign("/api/export") 触发浏览器下载
//   （响应带 Content-Disposition: attachment，不离开当前页）；
// - 「导入」选择 JSON 文件 → 读取文本 → window.confirm 二次确认（取消则不发请求）
//   → POST /api/import（body 为文件原文，结构与数据校验都在服务端）
//   → 成功 router.refresh() 刷新 Server Component 显示新数据；
// - 导入进行中禁用两个按钮防重复提交；失败显示服务端 { error } 文案，
//   错误文案提取复用 components/today-form.ts 的 apiErrorMessage。

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";

import { apiErrorMessage } from "@/components/today-form";

const IMPORT_CONFIRM_TEXT = "导入将清空现有数据并替换为文件内容，确定继续？";
const IMPORT_FAILED_FALLBACK = "导入失败，请稍后再试";

const NEUTRAL_BUTTON =
  "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60";

export function BackupActions() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    if (importing) return;
    setError(null);
    window.location.assign("/api/export");
  }

  function handleImportClick() {
    if (importing) return;
    setError(null);
    fileInputRef.current?.click();
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 立即重置选择，同一文件下次还可再次选择
    event.target.value = "";
    if (!file || importing) return;

    // 二次确认：取消则不发起任何请求
    if (!window.confirm(IMPORT_CONFIRM_TEXT)) return;

    setImporting(true);
    try {
      const text = await file.text();
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      if (response.ok) {
        router.refresh();
      } else {
        setError(await apiErrorMessage(response, IMPORT_FAILED_FALLBACK));
      }
    } catch {
      // 文件读取失败或网络异常：统一兜底文案
      setError(IMPORT_FAILED_FALLBACK);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={importing}
          className={NEUTRAL_BUTTON}
          aria-label="导出数据为 JSON 文件"
        >
          导出
        </button>
        <button
          type="button"
          onClick={handleImportClick}
          disabled={importing}
          className={NEUTRAL_BUTTON}
          aria-label="从 JSON 文件导入数据"
        >
          {importing ? "导入中…" : "导入"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
