// 单个标签接口（docs/01-architecture.md「接口约定」、Issue #39）：
// - PATCH  /api/tags/:id：更新 name / color（未知字段 → 400；非法值 → 400；
//   显式 color=null 清空颜色；重名 → 400「标签名已存在」）；标签不存在 → 404；
// - DELETE /api/tags/:id：成功 204；标签不存在 → 404。挂在该标签上的任务绑定
//   （TaskTag）由数据库外键级联删除，任务本身保留。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { deleteTag, updateTag, type UpdateTagPatch } from "@/lib/db/tags";

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH 允许更新的字段；其余（如 id、tasks）一律 400。 */
const PATCHABLE_FIELDS = new Set(["name", "color"]);

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "请求体必须是 JSON 对象");
  }

  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!PATCHABLE_FIELDS.has(key)) {
      return jsonError(400, `不支持更新的字段：${key}`);
    }
  }

  try {
    // 字段校验在数据层完成（name 非空 ≤24 字符、color 为 #RRGGBB 或 null），
    // 重名映射为 TagValidationError → 400；标签不存在 → TagNotFoundError → 404。
    // 请求体尚未校验，这里仅做类型断言。
    const tag = await updateTag(id, body as UpdateTagPatch);
    return jsonOk(tag);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    await deleteTag(id);
  } catch (error) {
    return toErrorResponse(error);
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
