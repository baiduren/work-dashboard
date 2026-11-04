// 标签领域逻辑（Issue #39，docs/01-architecture.md「模块边界」「数据模型」）：
// 纯函数、可单测、不依赖数据库与框架。
// 职责：
// 1. 标签名取值校验（trim 后非空、≤24 字符）；
// 2. 标签颜色取值校验（#RRGGBB 或 null，与项目颜色同一规则，见 lib/domain/color.ts）；
// 3. 任务绑定的 tagIds 校验（非空字符串数组）。
// 非法输入统一抛出 TaskValidationError（映射 400）；标签名重复抛出 TagValidationError
// （TaskValidationError 子类，同样映射 400，由数据层捕获唯一约束后抛出）。

import { TaskValidationError } from "./task";
import { parseHexColor } from "./color";

/** 标签名最大长度（Issue #39：trim 后超过 24 字符拒绝）。 */
export const TAG_NAME_MAX_LENGTH = 24;

/**
 * 校验标签名：必须是非空字符串（首尾空白会被裁掉），trim 后超过 24 字符拒绝。
 * 非法输入抛 TaskValidationError（field="name"）。
 */
export function parseTagName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TaskValidationError(`name 必须是字符串，收到：${stringify(value)}`, "name");
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new TaskValidationError("name 不能为空", "name");
  }
  if (name.length > TAG_NAME_MAX_LENGTH) {
    throw new TaskValidationError(
      `name 不能超过 ${TAG_NAME_MAX_LENGTH} 个字符（当前 ${name.length} 个）`,
      "name",
    );
  }
  return name;
}

/**
 * 校验标签颜色：`#RRGGBB` 十六进制或 null（undefined / 空串视为 null，表示无颜色）。
 * 规则与项目颜色一致（lib/domain/color.ts 的共用实现）。
 */
export function parseTagColor(value: unknown): string | null {
  return parseHexColor(value, "color");
}

/**
 * 校验任务绑定的标签 id 列表：必须是字符串数组且每项 trim 后非空。
 * 返回裁剪后的 id 数组（保持原顺序）；输入不是数组或含非法项抛 TaskValidationError
 * （field="tagIds"）。重复 id 由数据层去重（TaskTag 主键不允许重复绑定）。
 */
export function parseTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TaskValidationError(
      `tagIds 必须是字符串数组，收到：${stringify(value)}`,
      "tagIds",
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TaskValidationError(
        `tagIds[${index}] 必须是非空字符串，收到：${stringify(item)}`,
        "tagIds",
      );
    }
    return item.trim();
  });
}

/**
 * 标签名重复（数据库唯一约束触发）：调用方应映射为 400。
 * 继承 TaskValidationError，复用现有 400 错误映射（docs/01-architecture.md「接口约定」）。
 */
export class TagValidationError extends TaskValidationError {
  constructor(message: string, field: string) {
    super(message, field);
    this.name = "TagValidationError";
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && value !== null) {
    return Array.isArray(value) ? "数组" : "对象";
  }
  return String(value);
}
