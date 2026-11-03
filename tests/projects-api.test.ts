import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as projectRoute, PATCH as patchRoute } from "../app/api/projects/[id]/route";
import { GET as listRoute, POST as createRoute } from "../app/api/projects/route";
import { prisma } from "../lib/db";
import { createProject, ProjectNotFoundError } from "../lib/db/projects";
import { createTask, type CreateTaskInput } from "../lib/db/tasks";
import { TaskValidationError } from "../lib/domain/task";

// 项目 HTTP API 集成测试（Issue #27「范围 3/5」）。
// 调用真实 route handler 函数 + 临时 SQLite（与 task-db / tasks-api 测试相同的准备方式），
// 不依赖也不触碰 prisma/dev.db；DATABASE_URL 必须在 lib/db 模块求值之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-projects-api-"));
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
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});
afterEach(async () => {
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});

// ---------------------------------------------------------------------------
// 请求与断言辅助
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000";

interface ProjectJson {
  id: string;
  name: string;
  color: string | null;
}

interface ProjectListJson {
  id: string;
  name: string;
  color: string | null;
  counts: { todo: number; doing: number; done: number; total: number };
}

function projectReq(id: string, method: string): NextRequest {
  return new NextRequest(`${BASE}/api/projects/${id}`, { method });
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

/** 直接经数据层造任务（计数场景用）。 */
async function seedTask(projectId: string, overrides: Partial<CreateTaskInput> = {}) {
  return createTask({ title: "任务", projectId, ...overrides }, new Date(2026, 10, 2, 12, 0, 0));
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe("GET /api/projects", () => {
  it("空库返回 []，带 Cache-Control: no-store", async () => {
    const res = await listRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("返回未归档项目数组，每项含 id/name/color/counts", async () => {
    const project = await createProject({ name: "项目一", color: "#3b82f6" });
    await seedTask(project.id, { title: "待办1" });
    await seedTask(project.id, { title: "进行中", status: "doing" });
    await seedTask(project.id, { title: "已完成", status: "done" });

    const res = await listRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectListJson[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(project.id);
    expect(body[0].name).toBe("项目一");
    expect(body[0].color).toBe("#3b82f6");
    expect(body[0].counts).toEqual({ todo: 1, doing: 1, done: 1, total: 3 });
  });

  it("归档项目不出现在响应里", async () => {
    await createProject({ name: "活跃项目" });
    await prisma.project.create({ data: { name: "已归档", archived: true } });

    const res = await listRoute();
    const body = (await res.json()) as ProjectListJson[];
    expect(body.map((project) => project.name)).toEqual(["活跃项目"]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects
// ---------------------------------------------------------------------------

describe("POST /api/projects", () => {
  it("创建成功 → 201 返回项目，且可在 GET 中看到", async () => {
    const res = await createRoute(jsonReq("/api/projects", "POST", { name: "官网改版" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ProjectJson;
    expect(body.name).toBe("官网改版");
    expect(body.color).toBeNull();
    expect(typeof body.id).toBe("string");

    const list = await listRoute();
    expect(((await list.json()) as ProjectListJson[]).map((project) => project.id)).toContain(
      body.id,
    );
  });

  it("合法 color 落库；名称裁剪首尾空白", async () => {
    const res = await createRoute(
      jsonReq("/api/projects", "POST", { name: "  工作汇报  ", color: "#22C55E" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ProjectJson;
    expect(body.name).toBe("工作汇报");
    expect(body.color).toBe("#22C55E");
  });

  it("空名称 / 超长名称 / 非法颜色 → 400，且不落库", async () => {
    const cases = [
      {},
      { name: "   " },
      { name: "x".repeat(61) },
      { name: "合法", color: "red" },
      { name: "合法", color: "#12345" },
      { name: "合法", color: 42 },
    ];
    for (const body of cases) {
      const res = await createRoute(jsonReq("/api/projects", "POST", body));
      expect(res.status).toBe(400);
      const error = (await res.json()) as { error: string };
      expect(typeof error.error).toBe("string");
    }
    expect(await prisma.project.count()).toBe(0);
  });

  it("请求体不是 JSON 或不是对象 → 400", async () => {
    expect((await createRoute(rawReq("/api/projects", "POST", "{not json"))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/projects", "POST", ["x"]))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/projects", "POST", "项目"))).status).toBe(400);
    expect(await prisma.project.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:id
// ---------------------------------------------------------------------------

describe("GET /api/projects/:id", () => {
  it("存在返回项目；不存在返回 404 { error }", async () => {
    const project = await createProject({ name: "项目一", color: "#ef4444" });
    const ok = await projectRoute(projectReq(project.id, "GET"), ctx(project.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()) as ProjectJson).toMatchObject({ name: "项目一", color: "#ef4444" });

    const missing = await projectRoute(projectReq("no-such-id", "GET"), ctx("no-such-id"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "项目不存在：no-such-id" });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/projects/:id", () => {
  it("改名 / 改色生效", async () => {
    const project = await createProject({ name: "旧名", color: "#ef4444" });
    const res = await patchRoute(
      jsonReq(`/api/projects/${project.id}`, "PATCH", { name: "新名", color: "#3b82f6" }),
      ctx(project.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectJson;
    expect(body.name).toBe("新名");
    expect(body.color).toBe("#3b82f6");
  });

  it("显式 color=null 清空颜色", async () => {
    const project = await createProject({ name: "项目一", color: "#ef4444" });
    const res = await patchRoute(
      jsonReq(`/api/projects/${project.id}`, "PATCH", { color: null }),
      ctx(project.id),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectJson).color).toBeNull();
  });

  it("空对象 PATCH 不改动字段，返回当前项目", async () => {
    const project = await createProject({ name: "原样" });
    const res = await patchRoute(jsonReq(`/api/projects/${project.id}`, "PATCH", {}), ctx(project.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectJson).name).toBe("原样");
  });

  it("非法颜色 / 名称 → 400 且不落库", async () => {
    const project = await createProject({ name: "项目一", color: "#ef4444" });
    for (const patch of [{ name: "" }, { name: "x".repeat(61) }, { color: "red" }, { color: 42 }]) {
      const res = await patchRoute(
        jsonReq(`/api/projects/${project.id}`, "PATCH", patch),
        ctx(project.id),
      );
      expect(res.status).toBe(400);
    }
    const after = await prisma.project.findUnique({ where: { id: project.id } });
    expect(after?.name).toBe("项目一");
    expect(after?.color).toBe("#ef4444");
  });

  it("未知字段 → 400 且不落库（archived 不在可更新范围）", async () => {
    const project = await createProject({ name: "项目一" });
    for (const patch of [{ archived: true }, { id: "other" }, { foo: "bar" }]) {
      const res = await patchRoute(
        jsonReq(`/api/projects/${project.id}`, "PATCH", patch),
        ctx(project.id),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
    }
    const after = await prisma.project.findUnique({ where: { id: project.id } });
    expect(after?.archived).toBe(false);
  });

  it("项目不存在 → 404；请求体不是 JSON / 不是对象 → 400", async () => {
    const missing = await patchRoute(
      jsonReq("/api/projects/no-such-id", "PATCH", { name: "x" }),
      ctx("no-such-id"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "项目不存在：no-such-id" });

    const project = await createProject({ name: "项目一" });
    expect((await patchRoute(rawReq(`/api/projects/${project.id}`, "PATCH", "{oops"), ctx(project.id))).status).toBe(400);
    expect((await patchRoute(jsonReq(`/api/projects/${project.id}`, "PATCH", ["x"]), ctx(project.id))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 计数联动（列表页展示语义）
// ---------------------------------------------------------------------------

describe("项目 API 与任务联动", () => {
  it("编辑任务所属项目后，GET /api/projects 的计数同步变化", async () => {
    const alpha = await createProject({ name: "Alpha" });
    const beta = await createProject({ name: "Beta" });
    const task = await seedTask(alpha.id, { title: "流动任务" });

    const readCounts = async () => {
      const res = await listRoute();
      const rows = (await res.json()) as ProjectListJson[];
      return new Map(rows.map((row) => [row.name, row.counts]));
    };

    let counts = await readCounts();
    expect(counts.get("Alpha")).toEqual({ todo: 1, doing: 0, done: 0, total: 1 });
    expect(counts.get("Beta")).toEqual({ todo: 0, doing: 0, done: 0, total: 0 });

    // 把任务改挂到 Beta（编辑弹层保存 projectId 的落库效果），计数应同步变化。
    await prisma.task.update({ where: { id: task.id }, data: { projectId: beta.id } });

    counts = await readCounts();
    expect(counts.get("Alpha")).toEqual({ todo: 0, doing: 0, done: 0, total: 0 });
    expect(counts.get("Beta")).toEqual({ todo: 1, doing: 0, done: 0, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// 错误类型导出（供 http.ts 映射）
// ---------------------------------------------------------------------------

describe("ProjectNotFoundError / TaskValidationError", () => {
  it("可被 instanceof 识别（调用方分别映射 404 / 400）", () => {
    const notFound = new ProjectNotFoundError("p1");
    expect(notFound.name).toBe("ProjectNotFoundError");
    expect(notFound.message).toContain("p1");
    expect(new TaskValidationError("bad", "name").field).toBe("name");
  });
});
