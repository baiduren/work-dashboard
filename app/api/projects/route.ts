// 项目集合接口（docs/01-architecture.md「接口约定」、Issue #27）：
// - GET /api/projects：未归档项目数组，每项含 id/name/color/counts（各状态任务数）；空库返回 []；
// - POST /api/projects：创建项目（name 必填，color 可选 #RRGGBB），成功 201 返回项目；
//   名称非法 / 超长 → 400，颜色非法 → 400。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。
// handler 保持薄：解析请求 → 校验（lib/domain / lib/db）→ 调用数据层 → 返回。

import { NextRequest, NextResponse } from "next/server";

import { jsonError, jsonOk, toErrorResponse } from "@/app/api/_lib/http";
import { createProject, listProjects, type CreateProjectInput } from "@/lib/db/projects";

export async function GET(): Promise<NextResponse> {
  try {
    return jsonOk(await listProjects());
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
    // createProject 内部经 parseProjectName / parseProjectColor 校验
    // （name 必填、trim 后 ≤60 字符；color 为 #RRGGBB 或 null），非法输入抛 TaskValidationError → 400。
    // 请求体尚未校验，这里仅做类型断言，运行时校验全部在数据层完成。
    const project = await createProject(body as CreateProjectInput);
    return jsonOk(project, 201);
  } catch (error) {
    return toErrorResponse(error);
  }
}
