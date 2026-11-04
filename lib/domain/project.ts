// 项目领域逻辑（docs/01-architecture.md「模块边界」「数据模型」）：纯函数、可单测、不依赖数据库与框架。
// 职责：
// 1. 项目名 / 颜色取值校验（颜色为 #RRGGBB 十六进制，null 表示清空）；
// 2. 项目更新补丁的归一化（只允许 name / color，归档与删除不在本工单范围）。
// 与任务一致，非法输入统一抛出 TaskValidationError，调用方据此映射为 400
// （docs/01-architecture.md「接口约定」；沿用现有错误类型即可被 400 映射）。

import { TaskValidationError } from "./task";
import { parseHexColor } from "./color";

/** 项目名最大长度（Issue #27：trim 后超过 60 字符拒绝）。 */
export const PROJECT_NAME_MAX_LENGTH = 60;

/** 新建项目表单的固定 6 色候选（UI 选择用；API 层接受任意合法 #RRGGBB）。 */
export const PROJECT_COLORS: readonly string[] = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
];

/** 新建项目表单的默认颜色。 */
export const DEFAULT_PROJECT_COLOR = "#3b82f6";

/** 校验项目名：必须是非空字符串（首尾空白会被裁掉），trim 后超过 60 字符拒绝。 */
export function parseProjectName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskValidationError(
      `name 必须是字符串，收到：${stringify(value)}`,
      "name",
    );
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new TaskValidationError("name 不能为空", "name");
  }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new TaskValidationError(
      `name 不能超过 ${PROJECT_NAME_MAX_LENGTH} 个字符（当前 ${name.length} 个）`,
      "name",
    );
  }
  return name;
}

/**
 * 校验项目颜色：`#RRGGBB` 十六进制；undefined / null / 空串 / 纯空白视为 null（清空颜色）。
 * 其余值（格式非法、类型不对）抛出 TaskValidationError。
 * 规则实现在 lib/domain/color.ts（Issue #39 提取共用，标签颜色同规则）。
 */
export function parseProjectColor(value: unknown): string | null {
  return parseHexColor(value, "color");
}

/** updateProject 的输入：仅允许 name / color。 */
export interface ProjectPatch {
  name?: string;
  color?: string | null;
}

export interface NormalizedProjectPatch {
  name?: string;
  color?: string | null;
}

/**
 * 归一化项目更新补丁：只挑选可更新字段（name / color，其余字段——包括 archived——
 * 一律忽略；归档/删除不在本工单范围）。未提供的字段不出现在结果里，
 * 显式 null 的 color 表示清空颜色。输入不是对象时抛出 TaskValidationError。
 */
export function normalizeProjectPatch(patch: unknown): NormalizedProjectPatch {
  const source = expectPlainObject(patch);
  const result: NormalizedProjectPatch = {};
  if (source.name !== undefined) result.name = parseProjectName(source.name);
  if (source.color !== undefined) result.color = parseProjectColor(source.color);
  return result;
}

function expectPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskValidationError(
      `patch 必须是对象，收到：${stringify(value)}`,
      "patch",
    );
  }
  return value as Record<string, unknown>;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "数组" : "对象";
  }
  return String(value);
}
