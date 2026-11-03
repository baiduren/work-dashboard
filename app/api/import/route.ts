// 数据导入接口（docs/01-architecture.md「数据导出 / 导入」、Issue #37）：
// POST /api/import 的 body 为导出的同构 JSON；lib/db/backup 的 importAll 在
// 单事务内先清空后导入，校验失败 / 事务失败都不破坏现有数据：
// - version 不支持 / 结构非法 → TaskValidationError → 400 固定文案；
// - 请求体不是合法 JSON → 400；
// - 成功返回 `{ imported: { projects, tasks, tags, taskTags } }` 计数。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { importAll } from "@/lib/db/backup";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }

  try {
    const imported = await importAll(body, { now: new Date() });
    return jsonOk({ imported });
  } catch (error) {
    return toErrorResponse(error);
  }
}
