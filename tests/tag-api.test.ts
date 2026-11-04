import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DELETE as deleteRoute, PATCH as patchRoute } from "../app/api/tags/[id]/route";
import { GET as listRoute, POST as createRoute } from "../app/api/tags/route";
import { prisma } from "../lib/db";
import { createTag, TagNotFoundError } from "../lib/db/tags";
import { TagValidationError } from "../lib/domain/tag";

// 标签 HTTP API 集成测试（Issue #39「范围 3」）。
// 调用真实 route handler 函数 + 临时 SQLite（与 task-db / tasks-api 测试相同的准备方式），
// 不依赖也不触碰 prisma/dev.db；DATABASE_URL 必须在 lib/db 模块求值之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-tag-api-"));
  // Windows 下 SQLite URL 用正斜杠的绝对路径
  const url = `file:${path.join(dir, "test.db").split(path.sep).join("/")}`;
  process.env.DATABASE_URL = url;
  return { dir, url };
});

beforeAll(
  () => {
    execSync("npx prisma migrate deploy", {
      env: process.env,
      stdio: "pipe",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
  },
  60_000,
);

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(tempDb.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.taskTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});
afterEach(async () => {
  await prisma.taskTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});

// ---------------------------------------------------------------------------
// 请求与断言辅助
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000";

interface TagJson {
  id: string;
  name: string;
  color: string | null;
}

function tagReq(id: string, method: string): NextRequest {
  return new NextRequest(`${BASE}/api/tags/${id}`, { method });
}

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function rawReq(path: string, method: string, body: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method, body });
}

/** Next.js 15 的 route handler 第二个参数：params 是 Promise。 */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// GET /api/tags
// ---------------------------------------------------------------------------

describe("GET /api/tags", () => {
  it("空库返回 []，带 Cache-Control: no-store", async () => {
    const res = await listRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("返回标签数组（按 name 升序），每项含 id/name/color", async () => {
    await createTag({ name: "周会" });
    await createTag({ name: "紧急", color: "#ef4444" });
    const res = await listRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as TagJson[];
    expect(body.map((tag) => tag.name)).toEqual(["周会", "紧急"]);
    expect(body[1]).toMatchObject({ name: "紧急", color: "#ef4444" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/tags
// ---------------------------------------------------------------------------

describe("POST /api/tags", () => {
  it("创建成功 → 201 返回标签，且可在 GET 中看到", async () => {
    const res = await createRoute(jsonReq("/api/tags", "POST", { name: "紧急" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TagJson;
    expect(body.name).toBe("紧急");
    expect(body.color).toBeNull();

    const list = await listRoute();
    expect(((await list.json()) as TagJson[]).map((tag) => tag.id)).toContain(body.id);
  });

  it("合法 color 落库；名称裁剪首尾空白", async () => {
    const res = await createRoute(jsonReq("/api/tags", "POST", { name: "  周会  ", color: "#22C55E" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as TagJson;
    expect(body.name).toBe("周会");
    expect(body.color).toBe("#22C55E");
  });

  it("重名创建 → 400 固定文案「标签名已存在」，且不新增行", async () => {
    await createTag({ name: "紧急" });
    const res = await createRoute(jsonReq("/api/tags", "POST", { name: "紧急" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "标签名已存在" });
    expect(await prisma.tag.count()).toBe(1);
  });

  it("空名称 / 超长名称 / 非法颜色 → 400，且不落库", async () => {
    const cases = [
      {},
      { name: "   " },
      { name: "x".repeat(25) },
      { name: "合法", color: "red" },
      { name: "合法", color: "#12345" },
      { name: "合法", color: 42 },
    ];
    for (const body of cases) {
      const res = await createRoute(jsonReq("/api/tags", "POST", body));
      expect(res.status).toBe(400);
      const error = (await res.json()) as { error: string };
      expect(typeof error.error).toBe("string");
    }
    expect(await prisma.tag.count()).toBe(0);
  });

  it("请求体不是 JSON 或不是对象 → 400", async () => {
    expect((await createRoute(rawReq("/api/tags", "POST", "{not json"))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/tags", "POST", ["紧急"]))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/tags", "POST", "紧急"))).status).toBe(400);
    expect(await prisma.tag.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/tags/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/tags/:id", () => {
  it("改名 / 改色生效", async () => {
    const tag = await createTag({ name: "旧名", color: "#ef4444" });
    const res = await patchRoute(
      jsonReq(`/api/tags/${tag.id}`, "PATCH", { name: "新名", color: "#3b82f6" }),
      ctx(tag.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TagJson;
    expect(body.name).toBe("新名");
    expect(body.color).toBe("#3b82f6");
  });

  it("显式 color=null 清空颜色", async () => {
    const tag = await createTag({ name: "标签", color: "#ef4444" });
    const res = await patchRoute(jsonReq(`/api/tags/${tag.id}`, "PATCH", { color: null }), ctx(tag.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TagJson).color).toBeNull();
  });

  it("重名 → 400「标签名已存在」；非法值 / 未知字段 → 400 且不落库", async () => {
    await createTag({ name: "甲" });
    const tag = await createTag({ name: "乙", color: "#ef4444" });

    const dup = await patchRoute(jsonReq(`/api/tags/${tag.id}`, "PATCH", { name: "甲" }), ctx(tag.id));
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ error: "标签名已存在" });

    for (const patch of [{ name: "" }, { color: "red" }, { name: "x".repeat(25) }, { id: "other" }, { foo: "bar" }]) {
      const res = await patchRoute(jsonReq(`/api/tags/${tag.id}`, "PATCH", patch), ctx(tag.id));
      expect(res.status).toBe(400);
    }
    const after = await prisma.tag.findUnique({ where: { id: tag.id } });
    expect(after?.name).toBe("乙");
    expect(after?.color).toBe("#ef4444");
  });

  it("标签不存在 → 404；请求体不是 JSON / 不是对象 → 400", async () => {
    const missing = await patchRoute(
      jsonReq("/api/tags/no-such-id", "PATCH", { name: "x" }),
      ctx("no-such-id"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "标签不存在：no-such-id" });

    const tag = await createTag({ name: "紧急" });
    expect((await patchRoute(rawReq(`/api/tags/${tag.id}`, "PATCH", "{oops"), ctx(tag.id))).status).toBe(400);
    expect((await patchRoute(jsonReq(`/api/tags/${tag.id}`, "PATCH", ["x"]), ctx(tag.id))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tags/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/tags/:id", () => {
  it("删除成功 → 204；再删除 → 404", async () => {
    const tag = await createTag({ name: "紧急" });
    const res = await deleteRoute(tagReq(tag.id, "DELETE"), ctx(tag.id));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await prisma.tag.count()).toBe(0);

    const again = await deleteRoute(tagReq(tag.id, "DELETE"), ctx(tag.id));
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "标签不存在：" + tag.id });
  });
});

// ---------------------------------------------------------------------------
// 错误类型导出（供 http.ts 映射）
// ---------------------------------------------------------------------------

describe("TagNotFoundError / TagValidationError", () => {
  it("可被 instanceof 识别（调用方分别映射 404 / 400）", () => {
    const notFound = new TagNotFoundError("t1");
    expect(notFound.name).toBe("TagNotFoundError");
    expect(notFound.message).toContain("t1");
    const dup = new TagValidationError("标签名已存在", "name");
    expect(dup.field).toBe("name");
  });
});
