"use client";

// 任务筛选栏（Issue #51，docs/01-architecture.md「接口约定」）：
// 今日视图与看板视图共用的 Client Component。关键词 / 优先级 / 标签写入 URL searchParams
// （router.replace，保持可分享与可后退），Server Component 按 searchParams 重新查询；
// 组件本身不做列表过滤（服务端筛选是正式能力；今日视图 Issue #39 的前端标签筛选仍保留）。
// - 关键词：输入防抖 300ms 触发，回车 / 「搜索」立即触发；
// - 优先级下拉：low | medium | high；
// - 标签下拉：数据来自 GET /api/tags（Issue #39 现有接口）；
// - 「清除筛选」一键复位三个参数。

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { parseFilterQuery } from "@/lib/domain/task-filter";
import type { TaskPriority } from "@/lib/domain/task";

interface TagOption {
  id: string;
  name: string;
}

const PRIORITY_OPTIONS: readonly { value: TaskPriority; label: string }[] = [
  { value: "high", label: "高优先级" },
  { value: "medium", label: "中优先级" },
  { value: "low", label: "低优先级" },
];

const FILTER_KEYS = ["q", "priority", "tagId"] as const;
const KEYWORD_DEBOUNCE_MS = 300;

export function TaskFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const qFromUrl = searchParams.get("q") ?? "";
  const priorityFromUrl = searchParams.get("priority") ?? "";
  const tagIdFromUrl = searchParams.get("tagId") ?? "";
  const filtersActive =
    parseFilterQuery(qFromUrl) !== undefined ||
    priorityFromUrl !== "" ||
    tagIdFromUrl !== "";

  const [keyword, setKeyword] = useState(qFromUrl);
  const [tags, setTags] = useState<TagOption[]>([]);

  // URL 变化（浏览器前进 / 后退、清除筛选）时同步输入框。
  useEffect(() => {
    setKeyword(qFromUrl);
  }, [qFromUrl]);

  // 标签下拉数据来自 GET /api/tags；失败时只隐藏标签选项，不阻塞其他筛选。
  useEffect(() => {
    let cancelled = false;
    async function loadTags() {
      try {
        const response = await fetch("/api/tags");
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (cancelled || !Array.isArray(data)) return;
        setTags(
          data.flatMap((item) => {
            const tag = item as Partial<TagOption>;
            return typeof tag.id === "string" && typeof tag.name === "string"
              ? [{ id: tag.id, name: tag.name }]
              : [];
          }),
        );
      } catch {
        // 标签接口暂不可用时只影响标签下拉，关键词 / 优先级筛选仍可用。
      }
    }
    void loadTags();
    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      for (const key of FILTER_KEYS) {
        if (!params.get(key)) params.delete(key);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const applyKeyword = useCallback(
    (value: string) => {
      navigate((params) => {
        const q = value.trim();
        if (q) params.set("q", q);
        else params.delete("q");
      });
    },
    [navigate],
  );

  // 输入防抖 300ms：URL 已同步时不重复导航。
  useEffect(() => {
    if (keyword.trim() === (parseFilterQuery(qFromUrl) ?? "")) return;
    const timer = setTimeout(() => applyKeyword(keyword), KEYWORD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword, qFromUrl, applyKeyword]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    applyKeyword(keyword);
  }

  function clearFilters() {
    setKeyword("");
    navigate((params) => {
      for (const key of FILTER_KEYS) params.delete(key);
    });
  }

  return (
    <form
      role="search"
      onSubmit={handleSubmit}
      aria-label="任务筛选"
      className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2.5"
    >
      <label htmlFor="task-filter-q" className="sr-only">
        搜索任务
      </label>
      <input
        id="task-filter-q"
        type="search"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="搜索标题或备注"
        className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-900"
      />
      <button
        type="submit"
        className="shrink-0 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      >
        搜索
      </button>
      <select
        aria-label="按优先级筛选"
        value={priorityFromUrl}
        onChange={(event) =>
          navigate((params) => {
            const value = event.target.value;
            if (value) params.set("priority", value);
            else params.delete("priority");
          })
        }
        className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-900"
      >
        <option value="">全部优先级</option>
        {PRIORITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        aria-label="按标签筛选任务"
        value={tagIdFromUrl}
        onChange={(event) =>
          navigate((params) => {
            const value = event.target.value;
            if (value) params.set("tagId", value);
            else params.delete("tagId");
          })
        }
        className="shrink-0 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-900"
      >
        <option value="">全部标签</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
      {filtersActive ? (
        <button
          type="button"
          onClick={clearFilters}
          className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-neutral-500 underline underline-offset-2 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          清除筛选
        </button>
      ) : null}
    </form>
  );
}
