// 任务集合接口（docs/01-architecture.md「接口约定（草案）」、Issue #19）：
// - GET /api/tasks?view=today|overdue|undated|board|project[&projectId=…]
//   board 返回按状态分组的结构；project 必须带 projectId；view 缺失或非法 → 400；
// - POST /api/tasks：创建任务（标题必填，其余字段可选），成功 201 返回任务。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。
// handler 保持薄：解析请求 → 校验（lib/domain / lib/db）→ 调用数据层 → 返回；
// 取值校验由 lib/db 复用 lib/domain 的纯函数完成，非法输入映射为 400。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { createTask, listTasks, type CreateTaskInput, type TaskListView } from "@/lib/db/tasks";

const VIEWS: readonly TaskListView[] = ["today", "overdue", "undated", "board", "project"];

function isView(value: string): value is TaskListView {
  return (VIEWS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const view = request.nextUrl.searchParams.get("view");
  if (view === null) {
    return jsonError(400, "缺少 view 参数");
  }
  if (!isView(view)) {
    return jsonError(400, `未知的任务视图：${view}`);
  }

  try {
    if (view === "board") {
      return jsonOk(await listTasks("board"));
    }
    if (view === "project") {
      const projectId = request.nextUrl.searchParams.get("projectId");
      if (projectId === null || projectId.trim() === "") {
        return jsonError(400, "project 视图必须提供 projectId");
      }
      return jsonOk(await listTasks("project", { projectId }));
    }
    // today / overdue / undated：以服务器当前时间做日期边界（lib/domain 计算边界）。
    return jsonOk(await listTasks(view, { now: new Date() }));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }

  try {
    // createTask 内部经 normalizeNewTask 校验全部字段（title 必填、
    // status/priority 取值、dueDate 可解析、projectId 必须存在），非法输入抛 TaskValidationError → 400。
    // 请求体尚未校验，这里仅做类型断言，运行时校验全部在数据层完成。
    const task = await createTask(body as CreateTaskInput);
    return jsonOk(task, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}
