// 标签集合接口（docs/01-architecture.md「接口约定」、Issue #39）：
// - GET /api/tags：全部标签数组（按 name 升序），空库返回 []；
// - POST /api/tags：创建标签（name 必填 ≤24、color 可选 #RRGGBB 或 null），
//   成功 201 返回标签；重名 400 固定文案「标签名已存在」。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。
// handler 保持薄：解析请求 → 校验（lib/domain / lib/db）→ 调用数据层 → 返回。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { createTag, listTags, type CreateTagInput } from "@/lib/db/tags";

export async function GET(): Promise<NextResponse> {
  try {
    return jsonOk(await listTags());
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "请求体必须是 JSON 对象");
  }

  try {
    // createTag 内部经 parseTagName / parseTagColor 校验（name 必填 ≤24 字符、
    // color 为 #RRGGBB 或 null），非法输入抛 TaskValidationError → 400；
    // 重名（唯一约束）抛 TagValidationError → 400 固定文案「标签名已存在」。
    // 请求体尚未校验，这里仅做类型断言，运行时校验全部在数据层完成。
    const tag = await createTag(body as CreateTagInput);
    return jsonOk(tag, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}
