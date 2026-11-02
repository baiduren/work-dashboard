// POST /api/auth/login：校验凭据并签发会话 Cookie（docs/adr/0004-authentication.md）。
// 不打日志（避免泄露凭据）；错误信息统一为“账号或密码错误”，不区分账号/密码错。

import { NextRequest, NextResponse } from "next/server";

import { readAuthConfig } from "@/lib/auth/config";
import { attemptLogin } from "@/lib/auth/login";
import { clientKeyFromRequest, loginRateLimiter } from "@/lib/auth/ratelimit";
import { SESSION_MAX_AGE_SECONDS, sessionCookieAttributes } from "@/lib/auth/session";

function readBodyField(body: unknown, field: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[field];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = readAuthConfig();
  if (!config) {
    return NextResponse.json(
      { error: "服务端认证未配置" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const clientKey = clientKeyFromRequest(request.headers);
  const result = await attemptLogin({
    username: readBodyField(body, "username"),
    password: readBodyField(body, "password"),
    clientKey,
    config,
    limiter: loginRateLimiter,
  });

  if (!result.ok) {
    if (result.reason === "limited") {
      return NextResponse.json(
        { error: "尝试过于频繁，请稍后再试" },
        {
          status: 429,
          headers: {
            "Retry-After": String(loginRateLimiter.retryAfterSeconds(clientKey)),
            "Cache-Control": "no-store",
          },
        },
      );
    }
    return NextResponse.json(
      { error: "账号或密码错误" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({ ...sessionCookieAttributes(SESSION_MAX_AGE_SECONDS), value: result.token });
  return response;
}
