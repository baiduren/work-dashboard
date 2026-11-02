import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { toErrorResponse } from "../app/api/_lib/http";
import { DELETE, GET as getTaskRoute, PATCH } from "../app/api/tasks/[id]/route";
import { POST as moveRoute } from "../app/api/tasks/[id]/move/route";
import { GET as listRoute, POST as createRoute } from "../app/api/tasks/route";
import { prisma } from "../lib/db";
import { createTask, getTask, TaskNotFoundError } from "../lib/db/tasks";
import { TaskValidationError } from "../lib/domain/task";

// 任务 CRUD HTTP API 集成测试（Issue #19）。
// 调用真实 route handler 函数 + 临时 SQLite（与 A 条 task-db.test.ts 相同的准备方式），
// 不依赖也不触碰 prisma/dev.db；DATABASE_URL 必须在 lib/db 模块求值之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-tasks-api-"));
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

interface TaskJson {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  projectId: string | null;
  orderIndex: number;
  completedAt: string | null;
}

type BoardJson = Record<"todo" | "doing" | "done", TaskJson[]>;

function listReq(search = ""): NextRequest {
  return new NextRequest(`${BASE}/api/tasks${search}`);
}

function taskReq(id: string, method: string): NextRequest {
  return new NextRequest(`${BASE}/api/tasks/${id}`, { method });
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

async function board(): Promise<BoardJson> {
  const res = await listRoute(listReq("?view=board"));
  expect(res.status).toBe(200);
  return (await res.json()) as BoardJson;
}

async function seedProject(name: string): Promise<{ id: string }> {
  return prisma.project.create({ data: { name }, select: { id: true } });
}

/** 「今天/昨天/明天」的本地时区正午，与视图查询的 new Date() 同一时区，与时刻无关。 */
function dayAt(dayOffset: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 12, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// GET /api/tasks?view=…
// ---------------------------------------------------------------------------

describe("GET /api/tasks", () => {
  it("空库 view=today 返回 []，带 Cache-Control: no-store", async () => {
    const res = await listRoute(listReq("?view=today"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("today / overdue / undated 归类正确", async () => {
    await createTask({ title: "今天到期", dueDate: dayAt(0) });
    await createTask({ title: "已逾期", dueDate: dayAt(-1) });
    await createTask({ title: "无日期" });
    await createTask({ title: "未来任务", dueDate: dayAt(1) });
    await createTask({ title: "今天但已完成", dueDate: dayAt(0), status: "done" });

    const titles = async (view: string) => {
      const res = await listRoute(listReq(`?view=${view}`));
      expect(res.status).toBe(200);
      return ((await res.json()) as TaskJson[]).map((task) => task.title);
    };
    expect(await titles("today")).toEqual(["今天到期"]);
    expect(await titles("overdue")).toEqual(["已逾期"]);
    expect(await titles("undated")).toEqual(["无日期"]);
  });

  it("board 返回按状态分组的结构，组内按 orderIndex", async () => {
    await createTask({ title: "todo-1" });
    await createTask({ title: "doing-1", status: "doing" });
    await createTask({ title: "done-1", status: "done" });

    const view = await board();
    expect(Object.keys(view).sort()).toEqual(["doing", "done", "todo"]);
    expect(view.todo.map((task) => task.title)).toEqual(["todo-1"]);
    expect(view.doing.map((task) => task.title)).toEqual(["doing-1"]);
    expect(view.done.map((task) => task.title)).toEqual(["done-1"]);
  });

  it("project 视图按 projectId 过滤", async () => {
    const project = await seedProject("项目一");
    await createTask({ title: "项目任务", projectId: project.id });
    await createTask({ title: "无项目" });

    const res = await listRoute(listReq(`?view=project&projectId=${project.id}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TaskJson[]).map((task) => task.title)).toEqual(["项目任务"]);
  });

  it("view=project 缺 projectId → 400", async () => {
    const res = await listRoute(listReq("?view=project"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "project 视图必须提供 projectId" });
  });

  it.each([
    ["", "缺少 view 参数"],
    ["?view=", "未知的任务视图："],
    ["?view=someday", "未知的任务视图：someday"],
  ])("view 缺失或非法（%s）→ 400", async (search, message) => {
    const res = await listRoute(listReq(search));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(message);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  it("创建成功 → 201 返回任务，应用缺省值，且可在 GET 中看到", async () => {
    const res = await createRoute(jsonReq("/api/tasks", "POST", { title: "新任务" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TaskJson;
    expect(body.title).toBe("新任务");
    expect(body.status).toBe("todo");
    expect(body.priority).toBe("medium");
    expect(body.completedAt).toBeNull();
    expect(typeof body.id).toBe("string");

    const view = await board();
    expect(view.todo.map((task) => task.title)).toContain("新任务");
  });

  it("完整字段创建：字段按输入落库", async () => {
    const project = await seedProject("项目");
    const dueDate = "2026-11-05T18:00:00.000Z";
    const res = await createRoute(
      jsonReq("/api/tasks", "POST", {
        title: "交付演示",
        notes: "带投影仪",
        priority: "high",
        dueDate,
        projectId: project.id,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as TaskJson;
    expect(body.notes).toBe("带投影仪");
    expect(body.priority).toBe("high");
    expect(body.dueDate).toBe(dueDate);
    expect(body.projectId).toBe(project.id);
  });

  it("缺 title 或空白 title → 400，且不落库", async () => {
    for (const body of [{}, { title: "   " }, { notes: "没有标题" }]) {
      const res = await createRoute(jsonReq("/api/tasks", "POST", body));
      expect(res.status).toBe(400);
      const error = (await res.json()) as { error: string };
      expect(typeof error.error).toBe("string");
    }
    expect(await prisma.task.count()).toBe(0);
  });

  it("非法 priority / status / dueDate / projectId → 400，且不落库", async () => {
    const cases = [
      { title: "x", priority: "urgent" },
      { title: "x", status: "paused" },
      { title: "x", dueDate: "not-a-date" },
      { title: "x", projectId: "missing-project" },
    ];
    for (const body of cases) {
      const res = await createRoute(jsonReq("/api/tasks", "POST", body));
      expect(res.status).toBe(400);
    }
    expect(await prisma.task.count()).toBe(0);
  });

  it("请求体不是 JSON 或不是对象 → 400", async () => {
    expect((await createRoute(rawReq("/api/tasks", "POST", "{not json"))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/tasks", "POST", ["x"]))).status).toBe(400);
    expect((await createRoute(jsonReq("/api/tasks", "POST", "标题"))).status).toBe(400);
    expect(await prisma.task.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

describe("GET /api/tasks/:id", () => {
  it("存在返回任务；不存在返回 404 { error }", async () => {
    const task = await createTask({ title: "任务A" });
    const ok = await getTaskRoute(taskReq(task.id, "GET"), ctx(task.id));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as TaskJson).title).toBe("任务A");

    const missing = await getTaskRoute(taskReq("no-such-id", "GET"), ctx("no-such-id"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "任务不存在：no-such-id" });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/tasks/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/tasks/:id", () => {
  it("更新 title / notes / priority / dueDate / projectId", async () => {
    const project = await seedProject("项目一");
    const task = await createTask({ title: "旧标题" });
    const dueDate = "2026-11-09T09:00:00.000Z";

    const res = await PATCH(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", {
        title: "新标题",
        notes: "备注",
        priority: "low",
        dueDate,
        projectId: project.id,
      }),
      ctx(task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskJson;
    expect(body.title).toBe("新标题");
    expect(body.notes).toBe("备注");
    expect(body.priority).toBe("low");
    expect(body.dueDate).toBe(dueDate);
    expect(body.projectId).toBe(project.id);
  });

  it("改 status 为 done 后 completedAt 非空；改回 todo 后为空", async () => {
    const task = await createTask({ title: "任务A" });

    const done = await PATCH(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", { status: "done" }),
      ctx(task.id),
    );
    expect(done.status).toBe(200);
    expect(((await done.json()) as TaskJson).completedAt).not.toBeNull();

    const back = await PATCH(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", { status: "todo" }),
      ctx(task.id),
    );
    expect(back.status).toBe(200);
    expect(((await back.json()) as TaskJson).completedAt).toBeNull();
  });

  it("status 与其他字段同时更新", async () => {
    const task = await createTask({ title: "旧标题" });
    const res = await PATCH(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", { title: "新标题", status: "doing" }),
      ctx(task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskJson;
    expect(body.title).toBe("新标题");
    expect(body.status).toBe("doing");
    expect(body.completedAt).toBeNull();
  });

  it("未知字段 → 400 且不落库", async () => {
    const task = await createTask({ title: "任务A" });
    for (const patch of [{ orderIndex: 5 }, { foo: "bar" }, { id: "other" }]) {
      const res = await PATCH(jsonReq(`/api/tasks/${task.id}`, "PATCH", patch), ctx(task.id));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
    }
    const after = await getTask(task.id);
    expect(after?.title).toBe("任务A");
    expect(after?.orderIndex).toBe(0);
  });

  it("非法值（priority/status/title/dueDate/projectId）→ 400 且不落库", async () => {
    const task = await createTask({ title: "任务A" });
    const cases = [
      { priority: "urgent" },
      { status: "paused" },
      { title: "" },
      { dueDate: "abc" },
      { projectId: 123 },
    ];
    for (const patch of cases) {
      const res = await PATCH(jsonReq(`/api/tasks/${task.id}`, "PATCH", patch), ctx(task.id));
      expect(res.status).toBe(400);
    }
    const after = await getTask(task.id);
    expect(after?.title).toBe("任务A");
    expect(after?.status).toBe("todo");
  });

  it("空对象 PATCH 不改动字段，返回当前任务", async () => {
    const task = await createTask({ title: "原样" });
    const res = await PATCH(jsonReq(`/api/tasks/${task.id}`, "PATCH", {}), ctx(task.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TaskJson).title).toBe("原样");
  });

  it("任务不存在 → 404；请求体不是 JSON / 不是对象 → 400", async () => {
    const missing = await PATCH(
      jsonReq("/api/tasks/no-such-id", "PATCH", { title: "x" }),
      ctx("no-such-id"),
    );
    expect(missing.status).toBe(404);

    const task = await createTask({ title: "任务A" });
    expect((await PATCH(rawReq(`/api/tasks/${task.id}`, "PATCH", "{oops"), ctx(task.id))).status).toBe(400);
    expect((await PATCH(jsonReq(`/api/tasks/${task.id}`, "PATCH", ["x"]), ctx(task.id))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/tasks/:id", () => {
  it("删除 → 204 无响应体；再次 DELETE → 404；GET 也 404", async () => {
    const task = await createTask({ title: "待删除" });

    const first = await DELETE(taskReq(task.id, "DELETE"), ctx(task.id));
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");

    const again = await DELETE(taskReq(task.id, "DELETE"), ctx(task.id));
    expect(again.status).toBe(404);
    expect((await again.json()) as { error: string }).toEqual({ error: `任务不存在：${task.id}` });

    const gone = await getTaskRoute(taskReq(task.id, "GET"), ctx(task.id));
    expect(gone.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/move
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/move", () => {
  it("同列移动后列内 orderIndex 连续、无重复、顺序正确（board 视图验证）", async () => {
    await createTask({ title: "A" });
    await createTask({ title: "B" });
    await createTask({ title: "C" });
    const d = await createTask({ title: "D" });

    const res = await moveRoute(
      jsonReq(`/api/tasks/${d.id}/move`, "POST", { status: "todo", orderIndex: 1 }),
      ctx(d.id),
    );
    expect(res.status).toBe(200);
    const moved = (await res.json()) as TaskJson;
    expect(moved.status).toBe("todo");
    expect(moved.orderIndex).toBe(1);

    const view = await board();
    expect(view.todo.map((task) => [task.title, task.orderIndex])).toEqual([
      ["A", 0],
      ["D", 1],
      ["B", 2],
      ["C", 3],
    ]);
  });

  it("跨列移动：目标列插入、源列收紧，各列 orderIndex 连续无重复（board 视图验证）", async () => {
    await createTask({ title: "A" });
    const b = await createTask({ title: "B" });
    await createTask({ title: "C" });
    await createTask({ title: "X", status: "doing" });

    const res = await moveRoute(
      jsonReq(`/api/tasks/${b.id}/move`, "POST", { status: "doing", orderIndex: 0 }),
      ctx(b.id),
    );
    expect(res.status).toBe(200);

    const view = await board();
    expect(view.todo.map((task) => task.title)).toEqual(["A", "C"]);
    expect(view.doing.map((task) => task.title)).toEqual(["B", "X"]);
    for (const column of ["todo", "doing", "done"] as const) {
      const indexes = view[column].map((task) => task.orderIndex).sort((a, b) => a - b);
      expect(indexes).toEqual(indexes.map((_, i) => i));
    }
  });

  it("移入 done 写 completedAt，移出清空", async () => {
    const task = await createTask({ title: "任务A" });

    const done = await moveRoute(
      jsonReq(`/api/tasks/${task.id}/move`, "POST", { status: "done", orderIndex: 0 }),
      ctx(task.id),
    );
    expect(((await done.json()) as TaskJson).completedAt).not.toBeNull();

    const back = await moveRoute(
      jsonReq(`/api/tasks/${task.id}/move`, "POST", { status: "todo", orderIndex: 0 }),
      ctx(task.id),
    );
    expect(((await back.json()) as TaskJson).completedAt).toBeNull();
  });

  it("非法状态 / 非法或缺失 orderIndex → 400", async () => {
    const task = await createTask({ title: "任务A" });
    const move = (body: unknown) => moveRoute(jsonReq(`/api/tasks/${task.id}/move`, "POST", body), ctx(task.id));

    expect((await move({ status: "someday", orderIndex: 0 })).status).toBe(400);
    expect((await move({ status: "todo" })).status).toBe(400);
    expect((await move({ status: "todo", orderIndex: "1" })).status).toBe(400);
    expect((await move({ status: "todo", orderIndex: 1.5 })).status).toBe(400);
    expect((await move({ orderIndex: 0 })).status).toBe(400);
  });

  it("任务不存在 → 404；请求体不是 JSON → 400", async () => {
    const missing = await moveRoute(
      jsonReq("/api/tasks/no-such-id/move", "POST", { status: "todo", orderIndex: 0 }),
      ctx("no-such-id"),
    );
    expect(missing.status).toBe(404);

    const task = await createTask({ title: "任务A" });
    const bad = await moveRoute(rawReq(`/api/tasks/${task.id}/move`, "POST", "nope"), ctx(task.id));
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 错误映射（无堆栈泄露）
// ---------------------------------------------------------------------------

describe("toErrorResponse", () => {
  it("TaskValidationError → 400、TaskNotFoundError → 404", () => {
    expect(toErrorResponse(new TaskValidationError("bad", "status")).status).toBe(400);
    expect(toErrorResponse(new TaskNotFoundError("t1")).status).toBe(404);
  });

  it("未知错误 → 500 固定文案，不泄露堆栈与内部信息", async () => {
    const res = toErrorResponse(new Error("内部细节：连接字符串 postgres://user:pass@host"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "服务器内部错误" });
  });
});
