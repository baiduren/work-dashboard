// POST /api/auth/logout：清除会话 Cookie，会话立即失效（客户端不再持有令牌）。
// Secure 属性与登录时保持同一套判断，避免 HTTP/HTTPS 部署下清不掉 Cookie。

import { NextRequest, NextResponse } from "next/server";

import { secureCookieForRequest, sessionCookieAttributes } from "@/lib/auth/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    ...sessionCookieAttributes(0, { secure: secureCookieForRequest(request) }),
    value: "",
  });
  return response;
}
