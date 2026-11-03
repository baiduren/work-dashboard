// 单个项目接口（docs/01-architecture.md「接口约定」、Issue #27）：
// - GET   /api/projects/:id：存在返回项目，不存在 404；
// - PATCH /api/projects/:id：更新 name / color（未知字段 → 400；非法值 → 400；
//   显式 color=null 清空颜色）；项目不存在 → 404。
// 归档 / 删除不在本工单范围（未提供 DELETE 与 archived 更新）。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { getProject, updateProject, type ProjectPatch } from "@/lib/db/projects";

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH 允许更新的字段；其余（如 archived、id、createdAt）一律 400。 */
const PATCHABLE_FIELDS = new Set(["name", "color"]);

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const project = await getProject(id);
    if (!project) return jsonError(404, `项目不存在：${id}`);
    return jsonOk(project);
  } catch (error) {
    return toErrorResponse(error);
  }
}

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
    // 字段校验在数据层经 normalizeProjectPatch 完成（name 非空 ≤60 字符、
    // color 为 #RRGGBB 或 null），非法输入抛 TaskValidationError → 400。
    // 请求体尚未校验，这里仅做类型断言。
    const project = await updateProject(id, body as ProjectPatch);
    return jsonOk(project);
  } catch (error) {
    return toErrorResponse(error);
  }
}
