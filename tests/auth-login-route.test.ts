import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "../app/api/auth/login/route";
import { loginRateLimiter } from "../lib/auth/ratelimit";

// 登录接口的 HTTP 约束（docs/02-acceptance.md「认证验收」）：
// Content-Type 必须为 application/json（否则 400）、请求体大小受限（超限 413）、
// 错误响应只含固定文案，不泄露堆栈或配置信息。

const USERNAME = "admin";
const PASSWORD = "correct-horse";
const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    AUTH_USERNAME: process.env.AUTH_USERNAME,
    AUTH_PASSWORD: process.env.AUTH_PASSWORD,
    AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
    AUTH_COOKIE_SECURE: process.env.AUTH_COOKIE_SECURE,
  };
  process.env.AUTH_USERNAME = USERNAME;
  process.env.AUTH_PASSWORD = PASSWORD;
  process.env.AUTH_SESSION_SECRET = SECRET;
  loginRateLimiter.clear();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function loginRequest(options: {
  body?: string;
  contentType?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-real-ip": options.ip ?? "203.0.113.200",
    ...options.headers,
  };
  if (options.contentType === null) delete headers["content-type"];
  else if (options.contentType) headers["content-type"] = options.contentType;
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ username: USERNAME, password: "wrong" }),
  });
}

describe("POST /api/auth/login 请求体约束", () => {
  it("application/json 正常登录成功并下发会话 Cookie", async () => {
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        ip: "203.0.113.201",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("wd_session=");
  });

  it("HTTP 请求下发的会话 Cookie 不带 Secure（HTTP 部署可登录并跳转）", async () => {
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        ip: "203.0.113.210",
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("wd_session=");
    expect(cookie).not.toMatch(/; *Secure/i);
  });

  it("经 HTTPS 代理（x-forwarded-proto: https）时 Cookie 带 Secure", async () => {
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        ip: "203.0.113.211",
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toMatch(/; *Secure/i);
  });

  it("AUTH_COOKIE_SECURE=false 可强制关闭 Secure（显式回退开关）", async () => {
    process.env.AUTH_COOKIE_SECURE = "false";
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        ip: "203.0.113.212",
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(/; *Secure/i);
  });

  it("Content-Type 带 charset 参数仍被接受（走到凭据校验）", async () => {
    const response = await POST(
      loginRequest({ contentType: "application/json; charset=utf-8", ip: "203.0.113.202" }),
    );
    // 密码错误 → 401，而不是请求格式错误
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "账号或密码错误" });
  });

  it("非 application/json 返回 400", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const response = await POST(loginRequest({ contentType, ip: "203.0.113.203" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "请求格式错误" });
    }
  });

  it("非 JSON 内容返回 400，不泄露解析细节", async () => {
    const response = await POST(loginRequest({ body: "not-json{{", ip: "203.0.113.204" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请求格式错误" });
  });

  it("Content-Length 声明超过 1KB 时直接返回 413", async () => {
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        headers: { "content-length": "5000" },
        ip: "203.0.113.205",
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "请求体过大" });
  });

  it("实际超过 1KB 的请求体返回 413（未声明 Content-Length 时按内容限制）", async () => {
    const response = await POST(
      loginRequest({ body: JSON.stringify({ pad: "a".repeat(2000) }), ip: "203.0.113.206" }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "请求体过大" });
  });

  it("Content-Length 声明偏小时仍按实际内容限制（逐块累计超限即停）", async () => {
    const response = await POST(
      loginRequest({
        body: "x".repeat(2000),
        headers: { "content-length": "10" },
        ip: "203.0.113.207",
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "请求体过大" });
  });

  it("1KB 内的正常请求不受影响", async () => {
    const response = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD, note: "x".repeat(800) }),
        ip: "203.0.113.208",
      }),
    );
    expect(response.status).toBe(200);
  });

  it("同来源连续失败 5 次后返回 429 与 Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await POST(
        loginRequest({
          body: JSON.stringify({ username: USERNAME, password: "wrong" }),
          ip: "203.0.113.209",
        }),
      );
      expect(response.status).toBe(401);
    }
    const limited = await POST(
      loginRequest({
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
        ip: "203.0.113.209",
      }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "尝试过于频繁，请稍后再试" });
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it("未配置认证环境时返回 500 且不含配置细节", async () => {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
    const response = await POST(loginRequest({ ip: "203.0.113.210" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务端认证未配置" });
  });
});
