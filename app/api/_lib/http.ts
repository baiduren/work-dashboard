// API route handlers 共用的响应与错误映射（docs/01-architecture.md「接口约定」）：
// - 成功返回资源本身；失败统一 `{ error: string }` 并带正确状态码；
// - TaskValidationError → 400、TaskNotFoundError → 404，其余一律 500 固定文案，不泄露堆栈；
// - 所有响应带 `Cache-Control: no-store`。
// 下划线开头的目录不参与 Next.js 路由，仅供本目录下的 route handlers 导入。

import { NextResponse } from "next/server";

import { TaskNotFoundError } from "@/lib/db/tasks";
import { TaskValidationError } from "@/lib/domain/task";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** JSON 成功响应（默认 200），统一带 Cache-Control: no-store。 */
export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** JSON 失败响应：`{ error }`，统一带 Cache-Control: no-store。 */
export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * 把领域/数据层异常映射为响应（docs/01-architecture.md「接口约定」）：
 * TaskValidationError（可识别的校验错误）→ 400，message 面向调用方；
 * TaskNotFoundError → 404；未知错误 → 500 固定文案，不携带堆栈或内部信息。
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof TaskValidationError) return jsonError(400, error.message);
  if (error instanceof TaskNotFoundError) return jsonError(404, error.message);
  return jsonError(500, "服务器内部错误");
}
