import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/db";
import { createProject, getProject, listProjects, ProjectNotFoundError, updateProject } from "../lib/db/projects";
import { createTask, updateStatus } from "../lib/db/tasks";
import { TaskValidationError } from "../lib/domain/task";

// 项目数据访问层集成测试（Issue #27「范围 2」）。
// 使用临时 SQLite 文件 + prisma migrate deploy，不依赖也不触碰 prisma/dev.db；
// DATABASE_URL 必须在 lib/db 模块求值（实例化 PrismaClient）之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-project-db-"));
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

// 每个用例独立清理（外键顺序：先任务后项目）
beforeEach(async () => {
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});
afterEach(async () => {
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
});

// 固定的“当前时间”，传给任务写操作。
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);

describe("createProject", () => {
  it("应用默认值并裁剪名称：color 缺省为 null", async () => {
    const project = await createProject({ name: "  官网改版  " });
    expect(project.name).toBe("官网改版");
    expect(project.color).toBeNull();
    expect(project.archived).toBe(false);
  });

  it("接受合法 color 并原样落库", async () => {
    const project = await createProject({ name: "工作", color: "#3B82F6" });
    expect(project.color).toBe("#3B82F6");
  });

  it("拒绝非法 name / color 且不落库", async () => {
    await expect(createProject({ name: "   " })).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "name",
    });
    await expect(createProject({ name: "x".repeat(61) })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await expect(createProject({ name: "x", color: "red" })).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "color",
    });
    await expect(createProject({ name: 42 as never })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    expect(await prisma.project.count()).toBe(0);
  });

  it("项目名重复不拒绝（schema 未加唯一约束，实现层不强制——与任务标题同策略，Issue #27 约定）", async () => {
    const first = await createProject({ name: "同名项目" });
    const second = await createProject({ name: "同名项目" });
    expect(first.id).not.toBe(second.id);
    const all = await listProjects();
    expect(all).toHaveLength(2);
    expect(all.map((project) => project.name)).toEqual(["同名项目", "同名项目"]);
  });
});

describe("getProject", () => {
  it("按 id 返回项目，未知 id 返回 null", async () => {
    const project = await createProject({ name: "项目一" });
    expect((await getProject(project.id))?.name).toBe("项目一");
    expect(await getProject("no-such-id")).toBeNull();
  });
});

describe("updateProject", () => {
  it("改名 / 改色生效", async () => {
    const project = await createProject({ name: "旧名", color: "#ef4444" });
    const updated = await updateProject(project.id, { name: "新名", color: "#22c55e" });
    expect(updated.name).toBe("新名");
    expect(updated.color).toBe("#22c55e");
  });

  it("显式 color=null 清空颜色；未提供的字段不变", async () => {
    const project = await createProject({ name: "项目一", color: "#ef4444" });
    const cleared = await updateProject(project.id, { color: null });
    expect(cleared.color).toBeNull();
    expect(cleared.name).toBe("项目一");

    const renamed = await updateProject(project.id, { name: "改名" });
    expect(renamed.name).toBe("改名");
    expect(renamed.color).toBeNull();
  });

  it("空补丁原样返回当前项目，不改动", async () => {
    const project = await createProject({ name: "原样", color: "#ef4444" });
    const same = await updateProject(project.id, {});
    expect(same.name).toBe("原样");
    expect(same.color).toBe("#ef4444");
  });

  it("忽略补丁中的不可更新字段（如 archived）", async () => {
    const project = await createProject({ name: "项目一" });
    const updated = await updateProject(project.id, { archived: true } as never);
    expect(updated.archived).toBe(false);
  });

  it("非法字段被拒绝且不落库", async () => {
    const project = await createProject({ name: "项目一", color: "#ef4444" });
    await expect(updateProject(project.id, { name: "" })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await expect(updateProject(project.id, { color: "#12345" })).rejects.toMatchObject({
      field: "color",
    });
    const after = await getProject(project.id);
    expect(after?.name).toBe("项目一");
    expect(after?.color).toBe("#ef4444");
  });

  it("项目不存在时抛出 ProjectNotFoundError", async () => {
    await expect(updateProject("no-such-id", { name: "x" })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(updateProject("no-such-id", {})).rejects.toMatchObject({
      name: "ProjectNotFoundError",
      projectId: "no-such-id",
    });
  });
});

describe("listProjects", () => {
  it("空库返回 []", async () => {
    expect(await listProjects()).toEqual([]);
  });

  it("返回未归档项目及各状态任务计数（todo/doing/done/total）", async () => {
    const project = await createProject({ name: "项目一", color: "#3b82f6" });
    await createTask({ title: "待办1", projectId: project.id }, NOW);
    await createTask({ title: "待办2", projectId: project.id }, NOW);
    await createTask({ title: "进行中", projectId: project.id, status: "doing" }, NOW);
    await createTask({ title: "已完成", projectId: project.id, status: "done" }, NOW);
    await createTask({ title: "无项目" }, NOW);

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toEqual({
      id: project.id,
      name: "项目一",
      color: "#3b82f6",
      counts: { todo: 2, doing: 1, done: 1, total: 4 },
    });
  });

  it("无任务的项目计数全 0；归档项目不出现在列表", async () => {
    const empty = await createProject({ name: "空项目" });
    // archived 字段不在本工单的 API 范围内，直接经 Prisma 造已归档数据。
    await prisma.project.create({ data: { name: "已归档", archived: true } });

    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(empty.id);
    expect(projects[0].counts).toEqual({ todo: 0, doing: 0, done: 0, total: 0 });
  });

  it("已归档项目的任务不计入任何展示计数", async () => {
    const archived = await prisma.project.create({ data: { name: "已归档", archived: true } });
    await createProject({ name: "活跃" });
    await createTask({ title: "归档项目里的任务", projectId: archived.id }, NOW);

    const projects = await listProjects();
    expect(projects.map((project) => project.name)).toEqual(["活跃"]);
    expect(projects[0].counts.total).toBe(0);
  });

  it("任务状态变化后计数同步（todo → done）", async () => {
    const project = await createProject({ name: "项目一" });
    const task = await createTask({ title: "任务A", projectId: project.id }, NOW);

    const before = await listProjects();
    expect(before[0].counts).toEqual({ todo: 1, doing: 0, done: 0, total: 1 });

    await updateStatus(task.id, "done", NOW);
    const after = await listProjects();
    expect(after[0].counts).toEqual({ todo: 0, doing: 0, done: 1, total: 1 });
  });
});
