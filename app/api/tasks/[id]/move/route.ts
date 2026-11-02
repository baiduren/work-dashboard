// 看板移动接口（docs/01-architecture.md「接口约定（草案）」、Issue #19）：
// POST /api/tasks/:id/move，body { status, orderIndex }：
// 按领域规则移动（lib/domain computeMove）并在同一事务内重排，
// 保证源列与目标列 orderIndex 均为 0..n-1、无重复；移动进出 done 维护 completedAt。
// 非法状态/位置 → 400；任务不存在 → 404。认证由 middleware.ts 统一保护。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { moveTask, type MoveTarget } from "@/lib/db/tasks";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }

  try {
    // moveTask 内部校验 status / orderIndex 取值（非法抛 TaskValidationError → 400）
    // 与任务存在性（不存在抛 TaskNotFoundError → 404）。
    const task = await moveTask(id, body as MoveTarget);
    return jsonOk(task);
  } catch (error) {
    return toErrorResponse(error);
  }
}
