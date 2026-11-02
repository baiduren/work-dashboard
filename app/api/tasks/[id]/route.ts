// 单个任务接口（docs/01-architecture.md「接口约定（草案）」、Issue #19）：
// - GET    /api/tasks/:id：存在返回任务，不存在 404；
// - PATCH  /api/tasks/:id：更新 title/notes/priority/dueDate/projectId/status，
//   未知字段或非法值 → 400。status 变更沿用领域规则维护 completedAt
//   （进入 done 写入、离开 done 清空、done→done 保留首次时间），
//   字段值经 lib/domain 归一化校验后经 lib/db 落库；列内重排走 /move；
// - DELETE /api/tasks/:id：成功 204，不存在 404。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import {
  normalizeTaskPatch,
  parseStatus,
  type NormalizedTaskPatch,
  type TaskStatus,
} from "@/lib/domain/task";
import {
  deleteTask,
  getTask,
  updateStatus,
  updateTask,
  type TaskRecord,
} from "@/lib/db/tasks";

type RouteContext = { params: Promise<{ id: string }> };

/** PATCH 允许更新的字段；其余（如 orderIndex、id、createdAt）一律 400，列内重排走 /move。 */
const PATCHABLE_FIELDS = new Set(["title", "notes", "priority", "dueDate", "projectId", "status"]);

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const task = await getTask(id);
    if (!task) return jsonError(404, `任务不存在：${id}`);
    return jsonOk(task);
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
  const source = body as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    if (!PATCHABLE_FIELDS.has(key)) {
      return jsonError(400, `不支持更新的字段：${key}`);
    }
  }

  // 先整体校验（值合法性），全部通过才落库，避免部分字段写入后另一字段被拒。
  let patch: NormalizedTaskPatch;
  try {
    patch = normalizeTaskPatch(source);
  } catch (error) {
    return toErrorResponse(error);
  }
  let nextStatus: TaskStatus | null = null;
  if (source.status !== undefined) {
    try {
      nextStatus = parseStatus(source.status);
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  try {
    let task: TaskRecord | null = null;
    if (Object.keys(patch).length > 0) task = await updateTask(id, patch);
    if (nextStatus !== null) task = await updateStatus(id, nextStatus);
    if (!task) task = await getTask(id); // 空 PATCH：不改动任何字段，返回当前任务
    if (!task) return jsonError(404, `任务不存在：${id}`);
    return jsonOk(task);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    await deleteTask(id);
  } catch (error) {
    return toErrorResponse(error);
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
