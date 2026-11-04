import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PATCH as patchTaskRoute } from "../app/api/tasks/[id]/route";
import { prisma } from "../lib/db";
import { exportAll, importAll } from "../lib/db/backup";
import { createTask, getTask, listTasks, updateTaskWithStatus } from "../lib/db/tasks";
import { createTag, setTaskTags } from "../lib/db/tags";
import { TaskValidationError } from "../lib/domain/task";

// 任务 ↔ 标签集成测试（Issue #39「范围 2/3/5」）：
// - PATCH tagIds 与字段更新 / status 变更同一事务（任一非法整体回滚）；
// - listTasks 各视图（today / board / project）返回 tags；
// - G 工单（Issue #37）导出导入与标签数据兼容：含标签的备份可完整恢复。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-task-tags-"));
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

const NOW = new Date(2026, 10, 4, 12, 0, 0, 0);

const BASE = "http://localhost:3000";

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Next.js 15 的 route handler 第二个参数：params 是 Promise。 */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function seedTaskWithTags(title = "任务A", tagNames: string[] = ["紧急"]) {
  const task = await createTask({ title, dueDate: new Date(2026, 10, 4, 18, 0, 0) }, NOW);
  const tags = [];
  for (const name of tagNames) {
    tags.push(await createTag({ name }));
  }
  await setTaskTags(task.id, tags.map((tag) => tag.id));
  return { task, tags };
}

// ---------------------------------------------------------------------------
// PATCH tagIds 与字段更新同事务（route handler 级）
// ---------------------------------------------------------------------------

describe("PATCH /api/tasks/:id 带 tagIds", () => {
  it("title + tagIds 同请求一起生效，响应带最新 tags", async () => {
    const { task } = await seedTaskWithTags("旧标题", []);
    const urgent = await createTag({ name: "紧急" });
    const weekly = await createTag({ name: "周会" });

    const res = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", {
        title: "新标题",
        tagIds: [urgent.id, weekly.id],
      }),
      ctx(task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; tags: { name: string }[] };
    expect(body.title).toBe("新标题");
    expect(body.tags.map((tag) => tag.name).sort()).toEqual(["周会", "紧急"].sort());
    expect(await prisma.taskTag.count()).toBe(2);
  });

  it("任一非法（如 tagIds 含不存在的 id）→ 400，标签与字段都不落库（事务回滚）", async () => {
    const { task } = await seedTaskWithTags("原标题", ["紧急"]);
    const weekly = await createTag({ name: "周会" });

    const res = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", {
        title: "被回滚的标题",
        tagIds: [weekly.id, "no-such-tag"],
      }),
      ctx(task.id),
    );
    expect(res.status).toBe(400);

    // 字段没有落库
    const after = await getTask(task.id);
    expect(after?.title).toBe("原标题");
    // 标签绑定整体回滚：既没有新增绑定，也没有清掉原有绑定
    const bindings = await prisma.taskTag.findMany({ where: { taskId: task.id } });
    expect(bindings).toHaveLength(1);
  });

  it("字段非法（priority 取值错误）→ 400，随请求提供的 tagIds 也不落库", async () => {
    const { task } = await seedTaskWithTags("任务A", []);
    const urgent = await createTag({ name: "紧急" });

    const res = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", {
        priority: "urgent",
        tagIds: [urgent.id],
      }),
      ctx(task.id),
    );
    expect(res.status).toBe(400);
    expect((await getTask(task.id))?.priority).toBe("medium");
    expect(await prisma.taskTag.count()).toBe(0);
  });

  it("PATCH 未提供 tagIds 时不动既有标签", async () => {
    const { task, tags } = await seedTaskWithTags("任务A", ["紧急", "周会"]);
    const res = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", { notes: "仅改备注" }),
      ctx(task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: { id: string }[] };
    expect(body.tags.map((tag) => tag.id).sort()).toEqual(tags.map((tag) => tag.id).sort());
  });

  it("tagIds: [] 清空绑定；tagIds 非数组 / 含非法项 → 400", async () => {
    const { task } = await seedTaskWithTags("任务A", ["紧急"]);
    const cleared = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", { tagIds: [] }),
      ctx(task.id),
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { tags: unknown[] }).tags).toEqual([]);

    for (const bad of ["tag-1", [""], [42], { 0: "tag-1" }]) {
      const res = await patchTaskRoute(
        jsonReq(`/api/tasks/${task.id}`, "PATCH", { tagIds: bad }),
        ctx(task.id),
      );
      expect(res.status).toBe(400);
    }
  });

  it("PATCH title + tagIds + status 同请求：字段、状态与标签一次生效", async () => {
    const { task } = await seedTaskWithTags("旧标题", []);
    const urgent = await createTag({ name: "紧急" });

    const res = await patchTaskRoute(
      jsonReq(`/api/tasks/${task.id}`, "PATCH", {
        title: "新标题",
        status: "done",
        tagIds: [urgent.id],
      }),
      ctx(task.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; status: string; completedAt: string | null; tags: { name: string }[] };
    expect(body.title).toBe("新标题");
    expect(body.status).toBe("done");
    expect(body.completedAt).not.toBeNull();
    expect(body.tags.map((tag) => tag.name)).toEqual(["紧急"]);
  });
});

// ---------------------------------------------------------------------------
// 数据层同事务语义（lib/db 级）
// ---------------------------------------------------------------------------

describe("updateTaskWithStatus 与标签绑定同事务", () => {
  it("tagIds 与字段更新一起生效；非法 tagId 整体回滚", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const tag = await createTag({ name: "紧急" });

    const updated = await updateTaskWithStatus(task.id, { title: "A2", tagIds: [tag.id] });
    expect(updated.title).toBe("A2");
    expect(updated.tags.map((t) => t.name)).toEqual(["紧急"]);

    await expect(
      updateTaskWithStatus(task.id, { title: "A3", tagIds: ["no-such-tag"] }),
    ).rejects.toMatchObject({ name: "TaskValidationError", field: "tagIds" });
    const after = await getTask(task.id);
    expect(after?.title).toBe("A2"); // 字段回滚
    expect(after?.tags.map((t) => t.name)).toEqual(["紧急"]); // 绑定保持
  });

  it("只有 tagIds（无字段 / status 变化）也能完成绑定并返回最新任务", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const tag = await createTag({ name: "紧急" });
    const updated = await updateTaskWithStatus(task.id, { tagIds: [tag.id] });
    expect(updated.title).toBe("任务A");
    expect(updated.tags.map((t) => t.name)).toEqual(["紧急"]);
  });

  it("tagIds + status 变更同事务：任务不存在 → 404 语义错误，绑定不落库", async () => {
    const tag = await createTag({ name: "紧急" });
    await expect(
      updateTaskWithStatus("no-such-id", { tagIds: [tag.id] }, "done", NOW),
    ).rejects.toBeInstanceOf(Object);
    expect(await prisma.taskTag.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTasks 各视图返回 tags
// ---------------------------------------------------------------------------

describe("listTasks 各视图带 tags", () => {
  it("today / board / project 三视图的任务都带 tags 字段且一致", async () => {
    const { task, tags } = await seedTaskWithTags("今日任务", ["紧急", "周会"]);
    const otherTag = await createTag({ name: "其他" });

    const today = await listTasks("today", { now: NOW });
    expect(today.map((t) => t.tags)).toBeTruthy();
    expect(today.find((t) => t.id === task.id)?.tags.map((tag) => tag.name).sort()).toEqual(
      ["周会", "紧急"].sort(),
    );

    const board = await listTasks("board");
    const boardTask = [...board.todo, ...board.doing, ...board.done].find(
      (t) => t.id === task.id,
    );
    expect(boardTask?.tags.map((tag) => tag.id).sort()).toEqual(tags.map((tag) => tag.id).sort());

    const project = await prisma.project.create({ data: { name: "项目" } });
    const projectTask = await createTask(
      { title: "项目任务", projectId: project.id },
      NOW,
    );
    await setTaskTags(projectTask.id, [otherTag.id]);
    const projectRows = await listTasks("project", { projectId: project.id });
    expect(projectRows.find((t) => t.id === projectTask.id)?.tags.map((tag) => tag.name)).toEqual([
      "其他",
    ]);
  });

  it("未绑定标签的任务返回空数组 tags（不缺字段）", async () => {
    const task = await createTask({ title: "无标签", dueDate: new Date(2026, 10, 4, 9, 0, 0) }, NOW);
    const today = await listTasks("today", { now: NOW });
    expect(today.find((t) => t.id === task.id)?.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G 工单兼容：导出 → 清库 → 导入，标签与绑定完整恢复
// ---------------------------------------------------------------------------

describe("导出 / 导入与标签数据兼容（Issue #37）", () => {
  it("导出含标签与绑定 → 清库 → 导入后完整恢复", async () => {
    const project = await prisma.project.create({ data: { name: "项目" } });
    const taskA = await createTask(
      { title: "任务A", projectId: project.id, dueDate: new Date(2026, 10, 4, 18, 0, 0) },
      NOW,
    );
    const taskB = await createTask({ title: "任务B" }, NOW);
    const urgent = await createTag({ name: "紧急", color: "#ef4444" });
    const weekly = await createTag({ name: "周会" });
    await setTaskTags(taskA.id, [urgent.id, weekly.id]);
    await setTaskTags(taskB.id, [urgent.id]);

    const backup = await exportAll();
    expect(backup.tags).toHaveLength(2);
    expect(backup.taskTags).toHaveLength(3);

    // 清库（外键顺序：taskTags → tags → tasks → projects）
    await prisma.taskTag.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    expect(await prisma.tag.count()).toBe(0);

    const counts = await importAll(JSON.parse(JSON.stringify(backup)));
    expect(counts).toEqual({ projects: 1, tasks: 2, tags: 2, taskTags: 3 });

    // 标签与任务绑定关系完整恢复（id、name、color、绑定集合一致）
    const restoredA = await getTask(taskA.id);
    expect(restoredA?.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [
        { id: urgent.id, name: "紧急", color: "#ef4444" },
        { id: weekly.id, name: "周会", color: null },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    const restoredB = await getTask(taskB.id);
    expect(restoredB?.tags.map((tag) => tag.id)).toEqual([urgent.id]);
    expect((await listTasks("today", { now: NOW })).find((t) => t.id === taskA.id)?.tags).toBeTruthy();
  });

  it("导入含悬空 tagId 的备份 → 400（TaskValidationError），不落库", async () => {
    await createTask({ title: "任务A" }, NOW);
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [],
      tasks: [],
      tags: [],
      taskTags: [{ taskId: "no-such-task", tagId: "no-such-tag" }],
    };
    await expect(importAll(backup)).rejects.toBeInstanceOf(TaskValidationError);
  });
});
