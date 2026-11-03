import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as exportRoute } from "../app/api/export/route";
import { POST as importRoute } from "../app/api/import/route";
import { GET as listRoute } from "../app/api/tasks/route";
import { prisma } from "../lib/db";
import { BACKUP_VERSION, type BackupData, type BackupTask } from "../lib/db/backup";
import { createTask } from "../lib/db/tasks";

// 导出 / 导入 HTTP API 集成测试（Issue #37）。
// 调用真实 route handler 函数 + 临时 SQLite（与 task-db.test.ts 相同的准备方式），
// 验证 200 / 400、Content-Disposition 附件头与「导入失败不破坏现有数据」。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-export-import-api-"));
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

interface TaskJson {
  id: string;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  orderIndex: number;
  completedAt: string | null;
}

type BoardJson = Record<"todo" | "doing" | "done", TaskJson[]>;

function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function rawReq(path: string, body: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method: "POST", body });
}

async function board(): Promise<BoardJson> {
  const res = await listRoute(new NextRequest(`${BASE}/api/tasks?view=board`));
  expect(res.status).toBe(200);
  return (await res.json()) as BoardJson;
}

/** 合法备份文件基底（version 1），用例按需覆写。 */
function sampleBackup(overrides: Partial<BackupData> = {}): BackupData {
  const taskA: BackupTask = {
    id: "task-1",
    title: "导入任务A",
    notes: null,
    status: "todo",
    priority: "medium",
    dueDate: "2026-11-05T00:00:00.000Z",
    projectId: "proj-1",
    orderIndex: 0,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-02T08:00:00.000Z",
    completedAt: null,
  };
  return {
    version: BACKUP_VERSION,
    exportedAt: "2026-11-03T08:00:00.000Z",
    projects: [{ id: "proj-1", name: "work", color: "#2563EB", archived: false }],
    tasks: [taskA],
    tags: [],
    taskTags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/export
// ---------------------------------------------------------------------------

describe("GET /api/export", () => {
  it("返回 200 附件下载：Content-Disposition / no-store / version 1 结构", async () => {
    const project = await prisma.project.create({ data: { name: "work" } });
    await createTask({ title: "导出任务", projectId: project.id });

    const res = await exportRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="work-dashboard-export-\d{8}-\d{6}\.json"$/,
    );

    const data = (await res.json()) as BackupData;
    expect(data.version).toBe(BACKUP_VERSION);
    expect(typeof data.exportedAt).toBe("string");
    expect(data.tasks.map((task) => task.title)).toContain("导出任务");
    expect(data.tasks[0]?.orderIndex).toBe(0);
    expect(typeof data.tasks[0]?.createdAt).toBe("string");
  });

  it("空库导出 → 200 空数组结构", async () => {
    const res = await exportRoute();
    expect(res.status).toBe(200);
    const data = (await res.json()) as BackupData;
    expect(data.projects).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.tags).toEqual([]);
    expect(data.taskTags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/import
// ---------------------------------------------------------------------------

describe("POST /api/import", () => {
  it("合法备份 → 200 { imported: 计数 }，数据恢复且看板一致", async () => {
    const res = await importRoute(jsonReq("/api/import", sampleBackup()));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ imported: { projects: 1, tasks: 1, tags: 0, taskTags: 0 } });

    const view = await board();
    expect(view.todo.map((task) => task.title)).toEqual(["导入任务A"]);
  });

  it("version 不支持 / 缺 tasks 字段 / task 类型错误 → 400，且现有数据不变", async () => {
    await createTask({ title: "现有任务" });
    const before = await board();

    const missingTasks = sampleBackup() as Partial<BackupData> as Record<string, unknown>;
    delete missingTasks.tasks;

    const cases: unknown[] = [
      { ...sampleBackup(), version: 99 },
      missingTasks,
      { ...sampleBackup(), tasks: [{ ...sampleBackup().tasks[0], status: "paused" }] },
    ];
    for (const body of cases) {
      const res = await importRoute(jsonReq("/api/import", body));
      expect(res.status).toBe(400);
      const error = (await res.json()) as { error: string };
      expect(typeof error.error).toBe("string");
      // 导入失败不破坏现有数据（未落库 / 事务回滚后与导入前一致）
      expect(await board()).toEqual(before);
    }
  });

  it("请求体不是合法 JSON → 400", async () => {
    const res = await importRoute(rawReq("/api/import", "{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "请求体不是合法 JSON" });
  });

  it("API 完整闭环：导出 → 导入 → 看板与导出前一致（含 id / 顺序 / 完成时间）", async () => {
    const project = await prisma.project.create({ data: { name: "work" } });
    await createTask({ title: "甲", projectId: project.id });
    await createTask({ title: "乙", projectId: project.id });
    await createTask({ title: "丙", status: "done" });
    const before = await board();

    const exported = await exportRoute();
    expect(exported.status).toBe(200);
    const backup = (await exported.json()) as BackupData;

    const imported = await importRoute(jsonReq("/api/import", backup));
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({
      imported: { projects: 1, tasks: 3, tags: 0, taskTags: 0 },
    });

    // 原样恢复：id、列内顺序、completedAt 全部一致
    expect(await board()).toEqual(before);
  });
});
