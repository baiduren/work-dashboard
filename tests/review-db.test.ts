import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/db";
import { createTask, listCompletedBetween, updateStatus } from "../lib/db/tasks";
import { weekRange } from "../lib/domain/review";
import { TaskValidationError } from "../lib/domain/task";

// 周回顾数据层集成测试（Issue #44）：listCompletedBetween。
// 使用临时 SQLite 文件 + prisma migrate deploy，不依赖也不触碰 prisma/dev.db；
// DATABASE_URL 必须在 lib/db 模块求值（实例化 PrismaClient）之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置（与 tests/task-db.test.ts 同一模式）。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-review-db-"));
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

// 固定的“当前时间”（本地时区周一 2026-11-02 12:00）：本周 = 11-02 00:00 ~ 11-09 00:00。
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);
const WEEK = weekRange(NOW);

async function createProject(name: string): Promise<{ id: string }> {
  return prisma.project.create({ data: { name }, select: { id: true } });
}

describe("listCompletedBetween", () => {
  it("只返回 completedAt 在 [from, to) 内的任务，按完成时间降序", async () => {
    await createTask({ title: "上周完成的", status: "done" }, new Date(2026, 9, 30, 10, 0, 0));
    await createTask({ title: "下周完成的", status: "done" }, new Date(2026, 10, 10, 10, 0, 0));
    // 本周三天完成，故意乱序创建以验证排序
    const wednesday = await createTask({ title: "周三完成", status: "done" }, new Date(2026, 10, 4, 20, 0, 0));
    const monday = await createTask({ title: "周一完成", status: "done" }, new Date(2026, 10, 2, 9, 0, 0));
    const tuesday = await createTask({ title: "周二完成", status: "done" }, new Date(2026, 10, 3, 9, 0, 0));

    const rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.id)).toEqual([wednesday.id, tuesday.id, monday.id]);
  });

  it("含头不含尾：completedAt = from 算本周，completedAt = to（下周一 00:00）不算", async () => {
    const atFrom = await createTask(
      { title: "恰在周一 00:00", status: "done" },
      new Date(2026, 10, 2, 0, 0, 0, 0),
    );
    await createTask(
      { title: "恰在下周一 00:00", status: "done" },
      new Date(2026, 10, 9, 0, 0, 0, 0),
    );

    const rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.title)).toEqual([atFrom.title]);
    // 下周一 00:00 的任务属于下周区间
    const nextWeek = await listCompletedBetween(WEEK.to, weekRange(new Date(2026, 10, 9)).to);
    expect(nextWeek.map((row) => row.title)).toEqual(["恰在下周一 00:00"]);
  });

  it("不筛项目、不筛状态：不同项目与无项目的完成任务都返回", async () => {
    const projectA = await createProject("项目A");
    const projectB = await createProject("项目B");
    await createTask({ title: "A 项目完成", projectId: projectA.id, status: "done" }, NOW);
    await createTask({ title: "B 项目完成", projectId: projectB.id, status: "done" }, NOW);
    await createTask({ title: "无项目完成", status: "done" }, NOW);

    const rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.title).sort()).toEqual(
      ["A 项目完成", "B 项目完成", "无项目完成"].sort(),
    );
  });

  it("未完成（completedAt 为空）的任务永远不出现；撤销完成即从回顾消失", async () => {
    const task = await createTask({ title: "未完成", dueDate: "2026-11-03" }, NOW);
    const done = await createTask({ title: "已完成", status: "done" }, NOW);

    let rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.id)).toEqual([done.id]);

    // 撤销完成（done → todo）后 completedAt 清空，不再出现在回顾（docs/01-architecture.md「数据模型」）
    await updateStatus(task.id, "done", NOW);
    await updateStatus(task.id, "todo", NOW);
    rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.id)).toEqual([done.id]);
  });

  it("完成 → 撤销 → 重新完成：completedAt 为最后一次完成时间，回顾出现在重新完成的那周（现有语义回归）", async () => {
    const task = await createTask({ title: "反复横跳", dueDate: "2026-11-02" }, NOW);
    const firstDone = new Date(2026, 10, 2, 10, 0, 0);
    const redoDone = new Date(2026, 10, 5, 16, 0, 0);

    await updateStatus(task.id, "done", firstDone);
    await updateStatus(task.id, "todo", NOW); // 撤销：completedAt 清空
    await updateStatus(task.id, "done", redoDone); // 重新完成：写新时间

    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.completedAt).toEqual(redoDone);

    // 出现在重新完成（周五 11-05）所在的那周，而不是首次完成的那天
    const rows = await listCompletedBetween(WEEK.from, WEEK.to);
    expect(rows.map((row) => row.id)).toEqual([task.id]);
    // 撤销后从回顾消失
    await updateStatus(task.id, "todo", NOW);
    expect(await listCompletedBetween(WEEK.from, WEEK.to)).toEqual([]);
  });

  it("拒绝非法区间：from / to 不是有效 Date，或 from ≥ to", async () => {
    await expect(
      listCompletedBetween(new Date("not-a-date"), WEEK.to),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(listCompletedBetween(WEEK.from, "2026-11-09" as never)).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await expect(
      listCompletedBetween(new Date(2026, 10, 9), WEEK.from),
    ).rejects.toMatchObject({ name: "TaskValidationError", field: "range" });
    await expect(listCompletedBetween(WEEK.from, WEEK.from)).rejects.toBeInstanceOf(
      TaskValidationError,
    );
  });
});
