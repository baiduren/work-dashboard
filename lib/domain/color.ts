// 十六进制颜色取值校验（Issue #39 从 lib/domain/project.ts 提取共用）：
// `#RRGGBB` 格式；undefined / null / 空串 / 纯空白视为 null（表示未设置颜色）。
// 项目与标签共用同一规则，保证两处颜色语义与错误文案一致
// （docs/01-architecture.md「模块边界」：取值校验为 lib/domain 纯函数）。

import { TaskValidationError } from "./task";

/** #RRGGBB 十六进制颜色。 */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * 校验十六进制颜色：`#RRGGBB`；undefined / null / 空串 / 纯空白视为 null（清空颜色）。
 * 其余值（格式非法、类型不对）抛出 TaskValidationError（field 由调用方指定）。
 */
export function parseHexColor(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new TaskValidationError(
      `${field} 必须是 #RRGGBB 十六进制字符串或 null，收到：${stringify(value)}`,
      field,
    );
  }
  const color = value.trim();
  if (color.length === 0) return null;
  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new TaskValidationError(
      `${field} 必须是 #RRGGBB 格式的十六进制颜色，收到：${JSON.stringify(value)}`,
      field,
    );
  }
  return color;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "数组" : "对象";
  }
  return String(value);
}
