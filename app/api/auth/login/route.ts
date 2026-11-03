// POST /api/auth/login：校验凭据并签发会话 Cookie（docs/adr/0004-authentication.md）。
// 不打日志（避免泄露凭据）；错误信息统一为“账号或密码错误”，不区分账号/密码错；
// 所有错误响应只含固定文案，不携带堆栈、校验细节或配置信息。
// 请求体约束：Content-Type 必须为 application/json（允许 charset 参数），
// 大小不超过 MAX_BODY_BYTES（超限 413），且读取时逐块累计、超限即停，不无上限缓冲。

import { NextRequest, NextResponse } from "next/server";

import { readAuthConfig } from "@/lib/auth/config";
import { attemptLogin } from "@/lib/auth/login";
import { clientKeyFromRequest, loginRateLimiter } from "@/lib/auth/ratelimit";
import { SESSION_MAX_AGE_SECONDS, secureCookieForRequest, sessionCookieAttributes } from "@/lib/auth/session";

/** 登录请求体大小上限：用户名 + 密码足够，同时防止超大请求体消耗内存。 */
const MAX_BODY_BYTES = 1024;

function readBodyField(body: unknown, field: string): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[field];
}

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * 读取请求体文本并限制大小：先按 Content-Length 预检（声明超限直接拒绝），
 * 再逐块读取、累计超过上限立即取消读取并返回 null，保证无论头部如何声明
 * 都不会缓冲超过上限的内容。读取失败按格式错误处理。
 */
async function readBodyTextLimited(request: NextRequest): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isInteger(declared) && declared > MAX_BODY_BYTES) return null;

  const stream = request.body;
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = readAuthConfig();
  if (!config) {
    return jsonError(500, "服务端认证未配置");
  }

  // Content-Type 必须为 application/json（允许 charset 等参数）。
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonError(400, "请求格式错误");
  }

  let text: string | null;
  try {
    text = await readBodyTextLimited(request);
  } catch {
    return jsonError(400, "请求格式错误");
  }
  if (text === null) {
    return jsonError(413, "请求体过大");
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError(400, "请求格式错误");
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
            "Retry-After": String(result.retryAfterSeconds),
            "Cache-Control": "no-store",
          },
        },
      );
    }
    return jsonError(401, "账号或密码错误");
  }

  const response = NextResponse.json({ ok: true });
  // Secure 属性按实际请求协议决定（HTTPS/代理 → true，纯 HTTP 部署 → false），
  // 否则浏览器会丢弃 Cookie，登录后仍被中间件判定未登录、跳回登录页。
  response.cookies.set({
    ...sessionCookieAttributes(SESSION_MAX_AGE_SECONDS, { secure: secureCookieForRequest(request) }),
    value: result.token,
  });
  return response;
}
