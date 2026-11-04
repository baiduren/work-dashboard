// 任务搜索 / 筛选参数的解析（Issue #51，docs/01-architecture.md「接口约定」）：
// 纯函数、可单测、不依赖数据库与框架。
// - q：匹配 title / notes 的包含关系（trim 后空串 / 纯空白视为未提供）；
// - priority：low | medium | high；
// - tagId：精确绑定标签的任务 id。
// route handler 对 priority 做严格 400 校验（lib/domain parsePriority），页面侧用本文件的
// 容错读取（非法 URL 参数视为未提供，避免手工改 URL 导致整页 500）。

import { TASK_PRIORITIES, type TaskPriority } from "@/lib/domain/task";

/** 可与 view 组合的任务筛选条件（各视图透传，Issue #51）。 */
export interface TaskFilters {
  q?: string;
  priority?: TaskPriority;
  tagId?: string;
}

/** 页面 searchParams / 查询参数的值形态（URLSearchParams.get 返回 string | null）。 */
export type FilterParamValue = string | string[] | null | undefined;

function first(value: FilterParamValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/** 关键词：trim 后空串 / 纯空白视为未提供。 */
export function parseFilterQuery(value: FilterParamValue): string | undefined {
  const raw = first(value);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 页面容错读取 priority：仅当是合法取值时生效，非法值视为未提供。 */
export function parseFilterPriorityLoose(value: FilterParamValue): TaskPriority | undefined {
  const raw = first(value);
  if (typeof raw !== "string") return undefined;
  return (TASK_PRIORITIES as readonly string[]).includes(raw) ? (raw as TaskPriority) : undefined;
}

/** 页面容错读取 tagId：空串 / 纯空白视为未提供。 */
export function parseFilterTagIdLoose(value: FilterParamValue): string | undefined {
  const raw = first(value);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 从页面 searchParams 读取筛选条件（非法值忽略，route 层另行严格校验）。 */
export function readPageTaskFilters(params: Record<string, FilterParamValue>): TaskFilters {
  return {
    q: parseFilterQuery(params.q),
    priority: parseFilterPriorityLoose(params.priority),
    tagId: parseFilterTagIdLoose(params.tagId),
  };
}

/** 是否至少有一个筛选条件生效（页面用于区分「无匹配任务」与真空态）。 */
export function hasActiveFilters(filters: TaskFilters): boolean {
  return filters.q !== undefined || filters.priority !== undefined || filters.tagId !== undefined;
}
