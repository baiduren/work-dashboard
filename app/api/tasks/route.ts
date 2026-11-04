// 任务集合接口（docs/01-architecture.md「接口约定（草案）」、Issue #19、Issue #51）：
// - GET /api/tasks?view=today|overdue|undated|board|project[&projectId=…]
//   [&q=…][&priority=low|medium|high][&tagId=…]
//   board 返回按状态分组的结构；project 必须带 projectId；view 缺失或非法 → 400；
//   q / priority / tagId 为可选筛选（可与任意视图叠加，Issue #51）：
//   q 匹配 title / notes（空串 / 纯空白视为未提供）、priority 非法值 → 400、
//   tagId 指向不存在的标签 → 400「标签不存在」；全缺省时行为与未引入筛选前一致；
// - POST /api/tasks：创建任务（标题必填，其余字段可选），成功 201 返回任务。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。
// handler 保持薄：解析请求 → 校验（lib/domain / lib/db）→ 调用数据层 → 返回；
// 取值校验由 route 层先做（非法值 400 快速失败），再进 lib/db 组装 where。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { createTask, listTasks, type CreateTaskInput, type TaskListView } from "@/lib/db/tasks";
import { parsePriority, type TaskPriority } from "@/lib/domain/task";
import { parseFilterQuery, type TaskFilters } from "@/lib/domain/task-filter";

const VIEWS: readonly TaskListView[] = ["today", "overdue", "undated", "board", "project"];

function isView(value: string): value is TaskListView {
  return (VIEWS as readonly string[]).includes(value);
}

/** 读取可选筛选参数（Issue #51）：q 容错（空串视为未提供），priority 严格校验，tagId 原样透传。 */
function readFilters(searchParams: URLSearchParams): { filters: TaskFilters; error?: NextResponse } {
  let priority: TaskPriority | undefined;
  const rawPriority = searchParams.get("priority");
  if (rawPriority !== null) {
    try {
      priority = parsePriority(rawPriority);
    } catch (error) {
      return { filters: {}, error: toErrorResponse(error) };
    }
  }
  const rawTagId = searchParams.get("tagId");
  return {
    filters: {
      q: parseFilterQuery(searchParams.get("q")),
      priority,
      tagId: rawTagId === null ? undefined : rawTagId,
    },
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const view = searchParams.get("view");
  if (view === null) {
    return jsonError(400, "缺少 view 参数");
  }
  if (!isView(view)) {
    return jsonError(400, `未知的任务视图：${view}`);
  }

  const { filters, error } = readFilters(searchParams);
  if (error) return error;

  try {
    if (view === "board") {
      return jsonOk(await listTasks("board", filters));
    }
    if (view === "project") {
      const projectId = searchParams.get("projectId");
      if (projectId === null || projectId.trim() === "") {
        return jsonError(400, "project 视图必须提供 projectId");
      }
      return jsonOk(await listTasks("project", { projectId, ...filters }));
    }
    // today / overdue / undated：以服务器当前时间做日期边界（lib/domain 计算边界）。
    return jsonOk(await listTasks(view, { now: new Date(), ...filters }));
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
