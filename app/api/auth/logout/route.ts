// POST /api/auth/logout：清除会话 Cookie，会话立即失效（客户端不再持有令牌）。

import { NextResponse } from "next/server";

import { sessionCookieAttributes } from "@/lib/auth/session";

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...sessionCookieAttributes(0), value: "" });
  return response;
}
