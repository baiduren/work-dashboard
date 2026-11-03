// 数据导出接口（docs/01-architecture.md「数据导出 / 导入」、Issue #37）：
// GET /api/export 返回全量备份 JSON，并带 `Content-Disposition: attachment`
// 让浏览器直接下载文件；`Cache-Control: no-store` 延续接口约定。
// 认证由 middleware.ts 统一保护（未登录 401），本文件不新增认证逻辑。
// handler 保持薄：调用 lib/db/backup 的 exportAll → 序列化返回。

import { NextResponse } from "next/server";

import { toErrorResponse } from "@/app/api/_lib/http";
import { exportAll } from "@/lib/db/backup";

/** 服务器本地时间的导出文件名时间戳：YYYYMMDD-HHmmss。 */
function exportFilename(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `work-dashboard-export-${date}-${time}.json`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const data = await exportAll();
    // 2 空格缩进序列化：备份文件人类可读、便于 diff（数据量为个人应用量级）。
    const body = JSON.stringify(data, null, 2);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(new Date())}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
