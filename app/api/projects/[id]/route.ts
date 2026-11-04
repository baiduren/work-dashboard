// 单个项目接口（docs/01-architecture.md「接口约定」、Issue #27、Issue #43）：
// - GET    /api/projects/:id：存在返回项目，不存在 404；
// - PATCH  /api/projects/:id：更新 name / color / archived（未知字段 → 400；非法值 → 400；
//   显式 color=null 清空颜色；archived=true 归档、false 恢复）；项目不存在 → 404；
// - DELETE /api/projects/:id：成功 204；项目不存在 404。只删除项目本身，
//   其下任务的 projectId 由 schema `onDelete: SetNull` 置空，任务本身保留（不级联删除）。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import {
  deleteProject,
  getProject,
  updateProject,
  type ProjectPatch,
} from "@/lib/db/projects";

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH 允许更新的字段；其余（如 id、createdAt）一律 400。 */
const PATCHABLE_FIELDS = new Set(["name", "color", "archived"]);

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
    // color 为 #RRGGBB 或 null、archived 为布尔值），非法输入抛 TaskValidationError → 400。
    // 请求体尚未校验，这里仅做类型断言。
    const project = await updateProject(id, body as ProjectPatch);
    return jsonOk(project);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    await deleteProject(id);
  } catch (error) {
    return toErrorResponse(error);
  }
  // 响应约定与任务 DELETE 一致（docs/01-architecture.md「接口约定」）：204 + no-store。
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
