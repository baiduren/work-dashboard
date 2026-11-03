import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../middleware";
import { deriveSessionKey, SESSION_MAX_AGE_SECONDS, signSessionToken, SESSION_COOKIE_NAME } from "../lib/auth/session";

// middleware 全站拦截行为（docs/02-acceptance.md「认证验收」）：
// 未登录页面 302 / API 401 / 放行清单 / 篡改 Cookie 视为未登录 / Origin 校验。

const USERNAME = "admin";
const PASSWORD = "test-password";
const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    AUTH_USERNAME: process.env.AUTH_USERNAME,
    AUTH_PASSWORD: process.env.AUTH_PASSWORD,
    AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
  };
  process.env.AUTH_USERNAME = USERNAME;
  process.env.AUTH_PASSWORD = PASSWORD;
  process.env.AUTH_SESSION_SECRET = SECRET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function validCookie(): Promise<string> {
  const key = await deriveSessionKey(SECRET, PASSWORD);
  const seconds = Math.floor(Date.now() / 1000);
  const token = await signSessionToken(
    { sub: USERNAME, iat: seconds, exp: seconds + SESSION_MAX_AGE_SECONDS },
    key,
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

async function passed(response: Response): Promise<boolean> {
  return response.headers.get("x-middleware-next") === "1";
}

describe("middleware 访问控制", () => {
  it("未登录访问页面 302 到 /login?next=…", async () => {
    const response = await middleware(request("/"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?next=%2F");
  });

  it("未登录访问带查询串的页面时 next 保留完整路径", async () => {
    const response = await middleware(request("/tasks?view=today"));
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Ftasks%3Fview%3Dtoday",
    );
  });

  it("未登录访问 API 返回 401 JSON", async () => {
    const response = await middleware(request("/api/tasks"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("未登录访问任务接口子路径 /api/tasks/:id 也返回 401 JSON", async () => {
    const response = await middleware(request("/api/tasks/task-123"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("放行 /login 与 /api/auth/login", async () => {
    expect(await passed(await middleware(request("/login")))).toBe(true);
    expect(await passed(await middleware(request("/api/auth/login")))).toBe(true);
  });

  it("放行静态资源（/_next/*、favicon.ico 与扩展名白名单文件）", async () => {
    expect(await passed(await middleware(request("/favicon.ico")))).toBe(true);
    expect(await passed(await middleware(request("/_next/static/chunk.js")))).toBe(true);
    expect(await passed(await middleware(request("/_next/webpack-hmr")))).toBe(true);
    expect(await passed(await middleware(request("/logo.png")))).toBe(true);
    expect(await passed(await middleware(request("/images/photo.jpeg")))).toBe(true);
    expect(await passed(await middleware(request("/fonts/inter.woff2")))).toBe(true);
  });

  it("扩展名大小写不敏感", async () => {
    expect(await passed(await middleware(request("/LOGO.PNG")))).toBe(true);
  });

  it("带点路径的扩展名不在白名单内时不放行（不再按「含点」放行）", async () => {
    expect((await middleware(request("/api/tasks.json"))).status).toBe(401);
    expect((await middleware(request("/notes/2026.11.02"))).status).toBe(302);
    expect((await middleware(request("/files/archive.zip"))).status).toBe(302);
    expect((await middleware(request("/api/tasks.JSON"))).status).toBe(401);
  });

  it("点开头或无扩展名的路径不放行", async () => {
    expect((await middleware(request("/.env"))).status).toBe(302);
    expect((await middleware(request("/.well-known/x"))).status).toBe(302);
    expect((await middleware(request("/tasks"))).status).toBe(302);
  });

  it("项目页面与项目接口同样被拦截（Issue #27）", async () => {
    expect((await middleware(request("/projects"))).status).toBe(302);
    expect((await middleware(request("/projects/proj-1"))).status).toBe(302);
    const api = await middleware(request("/api/projects"));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "未登录" });
  });

  it("导出 / 导入接口同样被拦截（Issue #37）：未登录 401，登录后放行", async () => {
    const exportResponse = await middleware(request("/api/export"));
    expect(exportResponse.status).toBe(401);
    expect(await exportResponse.json()).toEqual({ error: "未登录" });
    expect(exportResponse.headers.get("cache-control")).toBe("no-store");

    const importResponse = await middleware(request("/api/import", { method: "POST" }));
    expect(importResponse.status).toBe(401);
    expect(await importResponse.json()).toEqual({ error: "未登录" });

    const cookie = await validCookie();
    expect(
      await passed(await middleware(request("/api/export", { headers: { cookie } }))),
    ).toBe(true);
    expect(
      await passed(
        await middleware(request("/api/import", { method: "POST", headers: { cookie } })),
      ),
    ).toBe(true);
  });

  it("有效会话访问页面与 API 放行", async () => {
    const cookie = await validCookie();
    expect(await passed(await middleware(request("/", { headers: { cookie } })))).toBe(true);
    expect(await passed(await middleware(request("/api/tasks", { headers: { cookie } })))).toBe(true);
  });

  it("篡改的会话 Cookie 视为未登录", async () => {
    const cookie = await validCookie();
    const tampered = `${cookie}x`;
    expect((await middleware(request("/", { headers: { cookie: tampered } }))).status).toBe(302);
  });

  it("过期会话视为未登录", async () => {
    const key = await deriveSessionKey(SECRET, PASSWORD);
    const token = await signSessionToken(
      { sub: USERNAME, iat: 1_000_000_000, exp: 1_000_000_100 },
      key,
    );
    const response = await middleware(request("/", { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));
    expect(response.status).toBe(302);
  });

  it("未配置认证环境时一律未登录（fail closed）", async () => {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    delete process.env.AUTH_SESSION_SECRET;
    const cookie = await validCookie();
    expect((await middleware(request("/", { headers: { cookie } }))).status).toBe(302);
    expect((await middleware(request("/api/tasks"))).status).toBe(401);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("跨站 %s 请求被 403 拒绝", async (method) => {
    const response = await middleware(
      request("/api/auth/login", {
        method,
        headers: { origin: "https://evil.example", host: "localhost:3000" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("同源变更请求放行（含仅 x-forwarded-host 的代理场景）", async () => {
    const sameOrigin = await middleware(
      request("/api/auth/login", {
        method: "POST",
        headers: { origin: "http://localhost:3000", host: "localhost:3000" },
      }),
    );
    expect(await passed(sameOrigin)).toBe(true);

    const viaProxy = await middleware(
      request("/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://dash.example.com",
          host: "internal:3000",
          "x-forwarded-host": "dash.example.com",
        },
      }),
    );
    expect(await passed(viaProxy)).toBe(true);
  });

  it("无 Origin 的变更请求（非浏览器客户端）放行", async () => {
    const response = await middleware(
      request("/api/auth/login", { method: "POST", headers: { host: "localhost:3000" } }),
    );
    expect(await passed(response)).toBe(true);
  });

  it("Origin 非法时拒绝", async () => {
    const response = await middleware(
      request("/api/auth/login", {
        method: "POST",
        headers: { origin: "null", host: "localhost:3000" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("GET 请求不做 Origin 校验", async () => {
    const response = await middleware(
      request("/", { headers: { origin: "https://evil.example", host: "localhost:3000" } }),
    );
    expect(response.status).toBe(302); // 未登录跳登录页，而非 403
  });
});
