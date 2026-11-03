import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/db";
import {
  BACKUP_VERSION,
  exportAll,
  importAll,
  type BackupData,
  type BackupTask,
} from "../lib/db/backup";
import { createTask, listTasks } from "../lib/db/tasks";
import { TaskValidationError } from "../lib/domain/task";

// 数据备份层集成测试（Issue #37）：
// exportAll 全字段导出 / importAll 清空后原样恢复（时间戳、顺序、completedAt 保留）、
// version 与结构校验（→ 400 语义）、导入中途失败整体回滚。
// 使用临时 SQLite 文件 + prisma migrate deploy，不依赖也不触碰 prisma/dev.db；
// DATABASE_URL 必须在 lib/db 模块求值之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-backup-db-"));
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

// 每个用例独立清理（外键顺序：taskTags → tags → tasks → projects）
async function clearAll(): Promise<void> {
  await prisma.taskTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
}

beforeEach(clearAll);
afterEach(clearAll);

/** 固定的“当前时间”（本地时区 2026-11-02 12:00）。 */
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 预置两个项目（含归档）与三个任务（覆盖全部状态、备注、截止日、完成时间）。 */
async function seedForExport(): Promise<{ projectId: string; archivedProjectId: string }> {
  const work = await prisma.project.create({ data: { name: "work", color: "#2563EB" } });
  const archived = await prisma.project.create({
    data: { name: "archived", color: null, archived: true },
  });
  await prisma.task.create({
    data: {
      id: "task-1",
      title: "看板第一条",
      notes: null,
      status: "todo",
      priority: "medium",
      dueDate: new Date("2026-11-03T00:00:00.000Z"),
      projectId: work.id,
      orderIndex: 0,
      createdAt: new Date("2026-11-01T08:00:00.000Z"),
      updatedAt: new Date("2026-11-01T09:00:00.000Z"),
      completedAt: null,
    },
  });
  await prisma.task.create({
    data: {
      id: "task-2",
      title: "进行中",
      notes: "备注内容",
      status: "doing",
      priority: "high",
      dueDate: null,
      projectId: null,
      orderIndex: 0,
      createdAt: new Date("2026-11-01T10:00:00.000Z"),
      updatedAt: new Date("2026-11-01T10:30:00.000Z"),
      completedAt: null,
    },
  });
  await prisma.task.create({
    data: {
      id: "task-3",
      title: "已完成",
      notes: null,
      status: "done",
      priority: "low",
      dueDate: null,
      projectId: archived.id,
      orderIndex: 0,
      createdAt: new Date("2026-11-02T08:00:00.000Z"),
      updatedAt: new Date("2026-11-02T10:30:00.000Z"),
      completedAt: new Date("2026-11-02T10:30:00.000Z"),
    },
  });
  return { projectId: work.id, archivedProjectId: archived.id };
}

/** 合法备份文件基底（version 1），用例按需覆写各字段。 */
function sampleBackup(overrides: Partial<BackupData> = {}): BackupData {
  const taskA: BackupTask = {
    id: "task-1",
    title: "任务A",
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
  const taskB: BackupTask = {
    id: "task-2",
    title: "任务B",
    notes: "备注",
    status: "done",
    priority: "high",
    dueDate: null,
    projectId: null,
    orderIndex: 0,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    completedAt: "2026-11-02T10:00:00.000Z",
  };
  return {
    version: BACKUP_VERSION,
    exportedAt: "2026-11-03T08:00:00.000Z",
    projects: [{ id: "proj-1", name: "work", color: "#2563EB", archived: false }],
    tasks: [taskA, taskB],
    tags: [],
    taskTags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exportAll
// ---------------------------------------------------------------------------

describe("exportAll", () => {
  it("返回 version 1 结构与全字段行：归档项目包含在内，日期为 ISO 字符串，tags/taskTags 为空数组", async () => {
    const seeded = await seedForExport();
    const data = await exportAll();

    expect(data.version).toBe(BACKUP_VERSION);
    expect(Number.isNaN(new Date(data.exportedAt).getTime())).toBe(false);

    // 项目按名称排序（archived < work），归档项目同样导出
    expect(data.projects).toEqual([
      { id: seeded.archivedProjectId, name: "archived", color: null, archived: true },
      { id: seeded.projectId, name: "work", color: "#2563EB", archived: false },
    ]);

    expect(data.tasks).toHaveLength(3);
    const byId = new Map(data.tasks.map((task) => [task.id, task]));
    expect(byId.get("task-1")).toEqual({
      id: "task-1",
      title: "看板第一条",
      notes: null,
      status: "todo",
      priority: "medium",
      dueDate: "2026-11-03T00:00:00.000Z",
      projectId: seeded.projectId,
      orderIndex: 0,
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
      completedAt: null,
    });
    expect(byId.get("task-2")).toEqual(
      expect.objectContaining({ status: "doing", notes: "备注内容", projectId: null }),
    );
    expect(byId.get("task-3")?.completedAt).toBe("2026-11-02T10:30:00.000Z");

    expect(data.tags).toEqual([]);
    expect(data.taskTags).toEqual([]);
  });

  it("空库导出返回空数组结构", async () => {
    const data = await exportAll();
    expect(data.version).toBe(BACKUP_VERSION);
    expect(typeof data.exportedAt).toBe("string");
    expect(data.projects).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.tags).toEqual([]);
    expect(data.taskTags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// importAll：正常导入
// ---------------------------------------------------------------------------

describe("importAll 正常导入", () => {
  it("按原 id 原样写入：保留 orderIndex / completedAt / createdAt / updatedAt 与项目归属", async () => {
    const counts = await importAll(sampleBackup(), { now: NOW });
    expect(counts).toEqual({ projects: 1, tasks: 2, tags: 0, taskTags: 0 });

    const project = await prisma.project.findUnique({ where: { id: "proj-1" } });
    expect(project?.name).toBe("work");
    expect(project?.archived).toBe(false);

    const restored = await prisma.task.findUnique({ where: { id: "task-1" } });
    expect(restored).not.toBeNull();
    expect(restored?.title).toBe("任务A");
    expect(restored?.orderIndex).toBe(0);
    expect(restored?.dueDate?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(restored?.createdAt.toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(restored?.updatedAt.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(restored?.projectId).toBe("proj-1");
    expect(restored?.completedAt).toBeNull();

    const done = await prisma.task.findUnique({ where: { id: "task-2" } });
    expect(done?.status).toBe("done");
    expect(done?.completedAt?.toISOString()).toBe("2026-11-02T10:00:00.000Z");

    // 看板视图与备份一致
    const board = await listTasks("board");
    expect(board.todo.map((task) => task.title)).toEqual(["任务A"]);
    expect(board.done.map((task) => task.title)).toEqual(["任务B"]);
  });

  it("导出 → 清空 → 导入 → 再导出：除 exportedAt 外逐字段一致（完整恢复）", async () => {
    await seedForExport();
    const first = await exportAll();

    const counts = await importAll(first);
    expect(counts).toEqual({ projects: 2, tasks: 3, tags: 0, taskTags: 0 });

    const second = await exportAll();
    expect(second).toEqual({ ...first, exportedAt: second.exportedAt });

    // @updatedAt 不会被导入改写（原值恢复）
    expect(second.tasks.find((task) => task.id === "task-1")?.updatedAt).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("先清空后导入：现有数据被备份内容替换", async () => {
    await createTask({ title: "旧任务" });
    await createTask({ title: "旧任务二" });
    expect(await prisma.task.count()).toBe(2);

    await importAll(sampleBackup());

    const titles = (await prisma.task.findMany()).map((task) => task.title).sort();
    expect(titles).toEqual(["任务A", "任务B"]);
  });

  it("tags / taskTags 校验结构后照写（含关联）", async () => {
    const counts = await importAll(
      sampleBackup({
        tags: [{ id: "tag-1", name: "紧急", color: "#DC2626" }],
        taskTags: [{ taskId: "task-1", tagId: "tag-1" }],
      }),
    );
    expect(counts).toEqual({ projects: 1, tasks: 2, tags: 1, taskTags: 1 });
    expect(await prisma.taskTag.count()).toBe(1);
    const tag = await prisma.tag.findUnique({ where: { id: "tag-1" } });
    expect(tag?.name).toBe("紧急");
  });

  it("空库导入全空数组 → 计数全 0", async () => {
    const counts = await importAll(sampleBackup({ projects: [], tasks: [] }));
    expect(counts).toEqual({ projects: 0, tasks: 0, tags: 0, taskTags: 0 });
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// importAll：结构与版本校验（不落库）
// ---------------------------------------------------------------------------

describe("importAll 校验失败", () => {
  it("version 缺失 / 类型不对 / 不支持 → TaskValidationError，且现有数据不变", async () => {
    await createTask({ title: "现有任务" });

    for (const version of [undefined, "1", 2, null]) {
      const backup: unknown = { ...sampleBackup(), version };
      await expect(importAll(backup)).rejects.toThrow(TaskValidationError);
      await expect(importAll(backup)).rejects.toThrow(/不支持的备份文件版本/);
    }
    // 校验先于任何数据库访问：现有数据不变
    expect(await prisma.task.count()).toBe(1);
  });

  it("顶层缺字段（exportedAt / projects / tasks / tags / taskTags）→ TaskValidationError", async () => {
    for (const key of ["exportedAt", "projects", "tasks", "tags", "taskTags"]) {
      const backup = sampleBackup() as Partial<BackupData> as Record<string, unknown>;
      delete backup[key];
      await expect(importAll(backup)).rejects.toThrow(TaskValidationError);
    }
  });

  it("行缺字段 / 行不是对象 / 字段类型错误 → TaskValidationError（错误信息带行定位）", async () => {
    const base = sampleBackup().tasks[0];

    const badTasks: unknown[] = [
      undefined, // 行不是对象
      { ...base, title: undefined }, // 缺 title
      { ...base, dueDate: "not-a-date" }, // 日期无法解析
      { ...base, createdAt: 123 }, // 时间戳不是字符串
      { ...base, status: "paused" }, // 非法 status
      { ...base, priority: "urgent" }, // 非法 priority
      { ...base, orderIndex: 1.5 }, // 非整数
      { ...base, projectId: "" }, // 空字符串的项目引用
    ];
    for (const task of badTasks) {
      await expect(importAll(sampleBackup({ tasks: [task as BackupTask] }))).rejects.toThrow(
        TaskValidationError,
      );
    }

    // 项目行缺 color / archived → 定位到 projects[0]
    await expect(
      importAll(
        sampleBackup({ projects: [{ id: "p", name: "x" }] as unknown as BackupData["projects"] }),
      ),
    ).rejects.toThrow(/projects\[0\]/);
  });

  it("非对象输入（null / 字符串 / 数字 / 数组）→ TaskValidationError", async () => {
    for (const input of [null, "x", 42, []]) {
      await expect(importAll(input)).rejects.toThrow(TaskValidationError);
    }
  });

  it("id 重复 / 引用悬空 → TaskValidationError", async () => {
    const project =
      sampleBackup().projects[0] ?? { id: "proj-1", name: "work", color: null, archived: false };
    await expect(
      importAll(sampleBackup({ projects: [project, { ...project, name: "another" }] })),
    ).rejects.toThrow(/重复/);

    await expect(
      importAll(
        sampleBackup({ tasks: [{ ...sampleBackup().tasks[0], projectId: "no-such-project" }] }),
      ),
    ).rejects.toThrow(/不存在的项目/);

    await expect(
      importAll(sampleBackup({ taskTags: [{ taskId: "task-1", tagId: "no-such-tag" }] })),
    ).rejects.toThrow(/不存在的标签/);
  });

  it("now 注入参数必须是 Date 实例（签名约定保留，类型严格）", async () => {
    await expect(
      importAll(sampleBackup(), { now: "2026-11-03" as unknown as Date }),
    ).rejects.toThrow(TaskValidationError);
  });
});

// ---------------------------------------------------------------------------
// importAll：事务回滚
// ---------------------------------------------------------------------------

describe("importAll 事务回滚", () => {
  it("导入中途失败（触发唯一约束）整体回滚：现有数据不变、不留下部分写入", async () => {
    await createTask({ title: "回滚前任务" });
    const before = await prisma.task.findMany();
    expect(before).toHaveLength(1);

    // 结构合法（id 唯一、无引用）但两个标签同名 → 写入第二个时触发
    // Tag.name 唯一约束（P2002）→ 事务内失败整体回滚，并映射为 TaskValidationError。
    const backup = sampleBackup({
      projects: [],
      tasks: [],
      tags: [
        { id: "tag-1", name: "dup", color: null },
        { id: "tag-2", name: "dup", color: null },
      ],
    });
    await expect(importAll(backup)).rejects.toThrow(/重复/);
    await expect(importAll(backup)).rejects.toThrow(TaskValidationError);

    const after = await prisma.task.findMany();
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe("回滚前任务");
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(await prisma.tag.count()).toBe(0); // 先成功写入的第一个标签也一并回滚
    expect(await prisma.project.count()).toBe(0);
  });
});
