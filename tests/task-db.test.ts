import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/db";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  moveTask,
  TaskNotFoundError,
  updateStatus,
  updateTask,
  updateTaskWithStatus,
  type TaskRecord,
} from "../lib/db/tasks";
import { classifyForToday, TaskValidationError, type TaskStatus } from "../lib/domain/task";

// 任务数据访问层集成测试（Issue #16「范围 2/3」）。
// 使用临时 SQLite 文件 + prisma migrate deploy，不依赖也不触碰 prisma/dev.db；
// DATABASE_URL 必须在 lib/db 模块求值（实例化 PrismaClient）之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-task-db-"));
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

// 固定的“当前时间”（本地时区 2026-11-02 12:00），传给写操作与视图查询。
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);

async function createProject(name: string): Promise<{ id: string }> {
  return prisma.project.create({ data: { name }, select: { id: true } });
}

/** 读取某状态列的任务（按 orderIndex 排序），用于断言列内顺序。 */
async function column(
  status: TaskStatus,
): Promise<Array<Pick<TaskRecord, "id" | "title"> & { orderIndex: number }>> {
  const rows = await prisma.task.findMany({ where: { status }, orderBy: [{ orderIndex: "asc" }] });
  return rows.map((row) => ({ id: row.id, title: row.title, orderIndex: row.orderIndex }));
}

describe("createTask", () => {
  it("应用缺省值并按列追加 orderIndex", async () => {
    const first = await createTask({ title: "任务A" }, NOW);
    expect(first.status).toBe("todo");
    expect(first.priority).toBe("medium");
    expect(first.completedAt).toBeNull();
    expect(first.dueDate).toBeNull();
    expect(first.orderIndex).toBe(0);

    const second = await createTask({ title: "任务B" }, NOW);
    expect(second.orderIndex).toBe(1);
  });

  it("完整字段写入，dueDate 接受日期字符串", async () => {
    const project = await createProject("工作");
    const task = await createTask(
      {
        title: "交付演示",
        notes: "带投影仪",
        priority: "high",
        dueDate: "2026-11-05T18:00:00",
        projectId: project.id,
      },
      NOW,
    );
    expect(task.title).toBe("交付演示");
    expect(task.notes).toBe("带投影仪");
    expect(task.priority).toBe("high");
    expect(task.dueDate).toEqual(new Date(2026, 10, 5, 18, 0, 0));
    expect(task.projectId).toBe(project.id);
  });

  it("拒绝非法 status / priority / title", async () => {
    await expect(createTask({ title: "x", status: "paused" as never }, NOW)).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await expect(
      createTask({ title: "x", priority: "urgent" as never }, NOW),
    ).rejects.toBeInstanceOf(TaskValidationError);
    await expect(createTask({ title: "  " }, NOW)).rejects.toBeInstanceOf(TaskValidationError);
    const created = await prisma.task.count();
    expect(created).toBe(0);
  });

  it("拒绝不存在的 projectId", async () => {
    await expect(createTask({ title: "x", projectId: "missing" }, NOW)).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "projectId",
    });
  });

  it("显式 orderIndex 插入指定位置并后移后续任务", async () => {
    await createTask({ title: "A" }, NOW);
    await createTask({ title: "B" }, NOW);
    await createTask({ title: "C" }, NOW);
    const inserted = await createTask({ title: "X", orderIndex: 1 }, NOW);
    expect(inserted.orderIndex).toBe(1);
    expect((await column("todo")).map((t) => [t.title, t.orderIndex])).toEqual([
      ["A", 0],
      ["X", 1],
      ["B", 2],
      ["C", 3],
    ]);
  });

  it("直接以 done 创建时写入 completedAt", async () => {
    const task = await createTask({ title: "已完成", status: "done" }, NOW);
    expect(task.status).toBe("done");
    expect(task.completedAt).toEqual(NOW);
  });
});

describe("getTask", () => {
  it("按 id 返回任务，未知 id 返回 null", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    expect((await getTask(task.id))?.title).toBe("任务A");
    expect(await getTask("no-such-id")).toBeNull();
  });
});

describe("updateTask", () => {
  it("更新 title / notes / priority / dueDate / projectId", async () => {
    const project = await createProject("项目一");
    const task = await createTask({ title: "旧标题" }, NOW);
    const updated = await updateTask(task.id, {
      title: "新标题",
      notes: "备注",
      priority: "low",
      dueDate: "2026-11-09T09:00:00",
      projectId: project.id,
    });
    expect(updated.title).toBe("新标题");
    expect(updated.notes).toBe("备注");
    expect(updated.priority).toBe("low");
    expect(updated.dueDate).toEqual(new Date(2026, 10, 9, 9, 0, 0));
    expect(updated.projectId).toBe(project.id);
  });

  it("显式 null 清空 dueDate 与 projectId", async () => {
    const project = await createProject("项目一");
    const task = await createTask(
      { title: "任务A", dueDate: "2026-11-05", projectId: project.id },
      NOW,
    );
    const cleared = await updateTask(task.id, { dueDate: null, projectId: null });
    expect(cleared.dueDate).toBeNull();
    expect(cleared.projectId).toBeNull();
  });

  it("非法字段被拒绝且不落库", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await expect(updateTask(task.id, { priority: "urgent" as never })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await expect(updateTask(task.id, { title: "" })).rejects.toBeInstanceOf(TaskValidationError);
    const after = await getTask(task.id);
    expect(after?.title).toBe("任务A");
    expect(after?.priority).toBe("medium");
  });

  it("忽略补丁中的不可更新字段（如 status）", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const updated = await updateTask(task.id, { status: "done" } as never);
    expect(updated.status).toBe("todo");
    expect(updated.completedAt).toBeNull();
  });

  it("任务不存在时抛出 TaskNotFoundError", async () => {
    await expect(updateTask("no-such-id", { title: "x" })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
});

describe("updateStatus", () => {
  it("todo → done 写入 completedAt", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const done = await updateStatus(task.id, "done", NOW);
    expect(done.status).toBe("done");
    expect(done.completedAt).toEqual(NOW);
  });

  it("done → todo 清空 completedAt（取消完成）", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await updateStatus(task.id, "done", NOW);
    const back = await updateStatus(task.id, "todo", NOW);
    expect(back.status).toBe("todo");
    expect(back.completedAt).toBeNull();
  });

  it("done → doing 同样清空 completedAt", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await updateStatus(task.id, "done", NOW);
    const doing = await updateStatus(task.id, "doing", NOW);
    expect(doing.status).toBe("doing");
    expect(doing.completedAt).toBeNull();
  });

  it("done → done 保留首次完成时间，不重置", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const first = new Date(2026, 10, 1, 9, 0, 0);
    await updateStatus(task.id, "done", first);
    const again = await updateStatus(task.id, "done", new Date(2026, 10, 2, 9, 0, 0));
    expect(again.completedAt).toEqual(first);
  });

  it("todo ↔ doing 不携带完成时间", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const doing = await updateStatus(task.id, "doing", NOW);
    expect(doing.status).toBe("doing");
    expect(doing.completedAt).toBeNull();
    const back = await updateStatus(task.id, "todo", NOW);
    expect(back.status).toBe("todo");
    expect(back.completedAt).toBeNull();
  });

  it("拒绝非法 status；任务不存在时抛 TaskNotFoundError", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await expect(updateStatus(task.id, "paused", NOW)).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "status",
    });
    await expect(updateStatus("no-such-id", "done", NOW)).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });
});

describe("updateTaskWithStatus", () => {
  it("字段 + status 单事务生效：status 变更追加到目标列末尾，原列收紧为 0..n-1", async () => {
    await createTask({ title: "A" }, NOW);
    const b = await createTask({ title: "B" }, NOW);
    await createTask({ title: "C" }, NOW);
    await createTask({ title: "X", status: "doing" }, NOW);

    const updated = await updateTaskWithStatus(b.id, { title: "B2" }, "doing", NOW);
    expect(updated.title).toBe("B2");
    expect(updated.status).toBe("doing");
    expect(updated.orderIndex).toBe(1); // 目标列长度（移入前 doing 只有 X）＝追加到末尾

    const todo = await column("todo");
    expect(todo.map((t) => [t.title, t.orderIndex])).toEqual([
      ["A", 0],
      ["C", 1],
    ]);
    const doing = await column("doing");
    expect(doing.map((t) => [t.title, t.orderIndex])).toEqual([
      ["X", 0],
      ["B2", 1],
    ]);
    for (const rows of [todo, doing]) {
      expect(new Set(rows.map((t) => t.orderIndex)).size).toBe(rows.length);
      expect(rows.map((t) => t.orderIndex)).toEqual(rows.map((_, i) => i));
    }
  });

  it("目标列已有任务时 status 变更：被移动任务在末尾，两列无重复（Issue #23 场景）", async () => {
    // 目标列（doing）已有 orderIndex=0 的任务；todo 列共 3 个
    await createTask({ title: "X", status: "doing" }, NOW);
    await createTask({ title: "A" }, NOW);
    const b = await createTask({ title: "B" }, NOW);
    await createTask({ title: "C" }, NOW);

    const moved = await updateTaskWithStatus(b.id, {}, "doing", NOW);
    expect(moved.orderIndex).toBe(1); // 追加到目标列末尾，不与已有 0 冲突

    const todo = await column("todo");
    const doing = await column("doing");
    expect(todo.map((t) => [t.title, t.orderIndex])).toEqual([
      ["A", 0],
      ["C", 1],
    ]);
    expect(doing.map((t) => [t.title, t.orderIndex])).toEqual([
      ["X", 0],
      ["B", 1],
    ]);
  });

  it("移入 done 写 completedAt，移出清空（沿用 applyStatusChange）", async () => {
    const task = await createTask({ title: "A" }, NOW);
    const doneAt = new Date(2026, 10, 2, 15, 0, 0);
    const done = await updateTaskWithStatus(task.id, { notes: "备注" }, "done", doneAt);
    expect(done.status).toBe("done");
    expect(done.notes).toBe("备注");
    expect(done.completedAt).toEqual(doneAt);

    const back = await updateTaskWithStatus(task.id, {}, "todo", NOW);
    expect(back.status).toBe("todo");
    expect(back.completedAt).toBeNull();
  });

  it("status 与当前相同：只维护 completedAt，不改变列内位置", async () => {
    const a = await createTask({ title: "A", status: "done" }, NOW);
    const b = await createTask({ title: "B", status: "done" }, NOW);
    const first = a.completedAt;
    expect(first).toEqual(NOW);

    const again = await updateTaskWithStatus(a.id, {}, "done", new Date(2026, 10, 3, 9, 0, 0));
    expect(again.completedAt).toEqual(first); // done → done 保留首次完成时间
    expect(again.orderIndex).toBe(0);

    const done = await column("done");
    expect(done.map((t) => [t.title, t.orderIndex])).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
    expect(b.orderIndex).toBe(1);
  });

  it("status 缺省时只更新字段（等价 updateTask）", async () => {
    const task = await createTask({ title: "A" }, NOW);
    const updated = await updateTaskWithStatus(
      task.id,
      { title: "A2", priority: "high" },
      undefined,
      NOW,
    );
    expect(updated.title).toBe("A2");
    expect(updated.priority).toBe("high");
    expect(updated.status).toBe("todo");
    expect(updated.orderIndex).toBe(0);
  });

  it("事务性：字段非法（projectId 不存在）整体回滚，status 与 completedAt 不落库", async () => {
    const task = await createTask({ title: "A" }, NOW);
    await expect(
      updateTaskWithStatus(task.id, { projectId: "missing" }, "done", NOW),
    ).rejects.toMatchObject({ name: "TaskValidationError", field: "projectId" });

    const after = await getTask(task.id);
    expect(after?.status).toBe("todo");
    expect(after?.completedAt).toBeNull();
    expect(after?.orderIndex).toBe(0);
  });

  it("空 patch 且无 status：原样返回当前任务，不改动", async () => {
    const task = await createTask({ title: "A" }, NOW);
    const same = await updateTaskWithStatus(task.id, {}, undefined, NOW);
    expect(same.title).toBe("A");
    expect(same.status).toBe("todo");
    expect(same.orderIndex).toBe(0);
  });

  it("拒绝非法 status；任务不存在时抛 TaskNotFoundError", async () => {
    const task = await createTask({ title: "A" }, NOW);
    await expect(updateTaskWithStatus(task.id, {}, "paused", NOW)).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "status",
    });
    await expect(
      updateTaskWithStatus("no-such-id", { title: "x" }, "done", NOW),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("moveTask", () => {
  it("同列移动后 orderIndex 连续、无重复、顺序正确", async () => {
    const a = await createTask({ title: "A" }, NOW);
    const b = await createTask({ title: "B" }, NOW);
    const c = await createTask({ title: "C" }, NOW);
    const d = await createTask({ title: "D" }, NOW);

    const moved = await moveTask(d.id, { status: "todo", orderIndex: 1 }, NOW);
    expect(moved.status).toBe("todo");
    expect(moved.orderIndex).toBe(1);

    const todo = await column("todo");
    expect(todo.map((t) => t.title)).toEqual(["A", "D", "B", "C"]);
    expect(todo.map((t) => t.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(todo.map((t) => t.orderIndex)).size).toBe(todo.length);
    expect(todo.map((t) => t.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
  });

  it("跨列移动：目标列插入 + 源列收紧，两列均 0..n-1", async () => {
    await createTask({ title: "A" }, NOW);
    const b = await createTask({ title: "B" }, NOW);
    await createTask({ title: "C" }, NOW);
    await createTask({ title: "X", status: "doing" }, NOW);

    await moveTask(b.id, { status: "doing", orderIndex: 0 }, NOW);
    const todo = await column("todo");
    const doing = await column("doing");
    expect(todo.map((t) => t.title)).toEqual(["A", "C"]);
    expect(todo.map((t) => t.orderIndex)).toEqual([0, 1]);
    expect(doing.map((t) => t.title)).toEqual(["B", "X"]);
    expect(doing.map((t) => t.orderIndex)).toEqual([0, 1]);
  });

  it("移动进入 done 设置 completedAt，移出清空", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    const doneAt = new Date(2026, 10, 2, 15, 0, 0);
    const done = await moveTask(task.id, { status: "done", orderIndex: 0 }, doneAt);
    expect(done.status).toBe("done");
    expect(done.completedAt).toEqual(doneAt);

    const back = await moveTask(task.id, { status: "todo", orderIndex: 0 }, NOW);
    expect(back.status).toBe("todo");
    expect(back.completedAt).toBeNull();
  });

  it("orderIndex 越界时收敛到列边界", async () => {
    await createTask({ title: "A" }, NOW);
    const b = await createTask({ title: "B" }, NOW);
    const toEnd = await moveTask(b.id, { status: "todo", orderIndex: 999 }, NOW);
    expect(toEnd.orderIndex).toBe(1);
    const toStart = await moveTask(b.id, { status: "todo", orderIndex: -5 }, NOW);
    expect(toStart.orderIndex).toBe(0);
  });

  it("拒绝非法 status；任务不存在时抛 TaskNotFoundError", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await expect(
      moveTask(task.id, { status: "someday", orderIndex: 0 }, NOW),
    ).rejects.toMatchObject({ name: "TaskValidationError", field: "status" });
    await expect(
      moveTask("no-such-id", { status: "todo", orderIndex: 0 }, NOW),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("deleteTask", () => {
  it("删除后不可再查询，重复删除抛 TaskNotFoundError", async () => {
    const task = await createTask({ title: "任务A" }, NOW);
    await deleteTask(task.id);
    expect(await getTask(task.id)).toBeNull();
    await expect(deleteTask(task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("listTasks", () => {
  it("board 返回 todo/doing/done 三组，组内按 orderIndex", async () => {
    await createTask({ title: "todo-1" }, NOW);
    await createTask({ title: "todo-2" }, NOW);
    const doing = await createTask({ title: "doing-1", status: "doing" }, NOW);
    await createTask({ title: "done-1", status: "done" }, NOW);

    const board = await listTasks("board");
    expect(Object.keys(board).sort()).toEqual(["doing", "done", "todo"]);
    expect(board.todo.map((t) => t.title)).toEqual(["todo-1", "todo-2"]);
    expect(board.doing.map((t) => t.title)).toEqual(["doing-1"]);
    expect(board.done.map((t) => t.title)).toEqual(["done-1"]);

    // 追加一个 doing 任务后组内顺序保持
    await createTask({ title: "doing-2", status: "doing" }, NOW);
    const again = await listTasks("board");
    expect(again.doing.map((t) => t.title)).toEqual(["doing-1", "doing-2"]);
    expect(doing.orderIndex).toBe(0);
  });

  it("today / overdue / undated 互斥分组：边界任务归入正确视图", async () => {
    // 以 NOW（2026-11-02 12:00 本地）为“今天”构造边界数据
    const todayTask = await createTask(
      { title: "今天 00:00", dueDate: new Date(2026, 10, 2, 0, 0, 0) },
      NOW,
    );
    const lateToday = await createTask(
      { title: "今天 23:59", dueDate: new Date(2026, 10, 2, 23, 59, 59, 999) },
      NOW,
    );
    const overdueTask = await createTask(
      { title: "昨天 23:59", dueDate: new Date(2026, 10, 1, 23, 59, 59, 999) },
      NOW,
    );
    await createTask({ title: "无日期" }, NOW);
    await createTask({ title: "明天", dueDate: new Date(2026, 10, 3, 0, 0, 0) }, NOW);
    await createTask(
      { title: "今天但已完成", dueDate: new Date(2026, 10, 2, 9, 0, 0), status: "done" },
      NOW,
    );
    await createTask({ title: "已完成的逾期", dueDate: new Date(2026, 9, 1), status: "done" }, NOW);

    const today = await listTasks("today", { now: NOW });
    expect(today.map((t) => t.title).sort()).toEqual([todayTask.title, lateToday.title].sort());
    const overdue = await listTasks("overdue", { now: NOW });
    expect(overdue.map((t) => t.title)).toEqual([overdueTask.title]);
    const undated = await listTasks("undated", { now: NOW });
    expect(undated.map((t) => t.title)).toEqual(["无日期"]);
  });

  it("视图查询与 classifyForToday 交叉验证一致", async () => {
    await createTask({ title: "t1", dueDate: new Date(2026, 10, 2, 8, 0, 0) }, NOW);
    await createTask({ title: "t2", dueDate: new Date(2026, 10, 2, 20, 0, 0) }, NOW);
    await createTask({ title: "t3", dueDate: new Date(2026, 10, 1) }, NOW);
    await createTask({ title: "t4" }, NOW);
    await createTask({ title: "t5", dueDate: new Date(2026, 10, 4) }, NOW);
    await createTask({ title: "t6", dueDate: new Date(2026, 10, 2), status: "done" }, NOW);

    const all = await prisma.task.findMany();
    const [today, overdue, undated] = await Promise.all([
      listTasks("today", { now: NOW }),
      listTasks("overdue", { now: NOW }),
      listTasks("undated", { now: NOW }),
    ]);
    const expected = { today: [] as string[], overdue: [] as string[], undated: [] as string[] };
    for (const row of all) {
      const bucket = classifyForToday(
        { dueDate: row.dueDate, status: row.status as TaskStatus },
        NOW,
      );
      if (bucket) expected[bucket].push(row.id);
    }
    expect(today.map((t) => t.id).sort()).toEqual(expected.today.sort());
    expect(overdue.map((t) => t.id).sort()).toEqual(expected.overdue.sort());
    expect(undated.map((t) => t.id).sort()).toEqual(expected.undated.sort());
  });

  it("today / overdue / undated 组内按 orderIndex 排序（Issue #52）", async () => {
    // 今天组：先创建 dueDate 较晚的任务，orderIndex 仍按创建顺序 → 排序以 orderIndex 主导。
    const todayLate = await createTask(
      { title: "今天-晚", dueDate: new Date(2026, 10, 2, 20, 0, 0) },
      NOW,
    );
    const todayEarly = await createTask(
      { title: "今天-早", dueDate: new Date(2026, 10, 2, 8, 0, 0) },
      NOW,
    );
    expect((await listTasks("today", { now: NOW })).map((t) => t.title)).toEqual([
      todayLate.title,
      todayEarly.title,
    ]);

    await moveTask(todayEarly.id, { status: "todo", orderIndex: 0 }, NOW);
    expect((await listTasks("today", { now: NOW })).map((t) => t.title)).toEqual([
      todayEarly.title,
      todayLate.title,
    ]);
  });

  it("新建任务 orderIndex 追加到列尾，出现在今日组末尾（Issue #52）", async () => {
    const a = await createTask(
      { title: "今天-A", dueDate: new Date(2026, 10, 2, 9, 0, 0) },
      NOW,
    );
    const b = await createTask(
      { title: "今天-B", dueDate: new Date(2026, 10, 2, 10, 0, 0) },
      NOW,
    );
    await moveTask(a.id, { status: "todo", orderIndex: 1 }, NOW);

    const c = await createTask(
      { title: "今天-新", dueDate: new Date(2026, 10, 2, 8, 0, 0) },
      NOW,
    );
    expect(c.orderIndex).toBe(2);
    expect((await listTasks("today", { now: NOW })).map((t) => t.title)).toEqual([
      b.title,
      a.title,
      c.title,
    ]);
  });

  it("组内移动 0→2：今日顺序与看板 orderIndex 同步（Issue #52）", async () => {
    const a = await createTask(
      { title: "A", dueDate: new Date(2026, 10, 2, 9, 0, 0) },
      NOW,
    );
    const b = await createTask(
      { title: "B", dueDate: new Date(2026, 10, 2, 9, 0, 0) },
      NOW,
    );
    const c = await createTask(
      { title: "C", dueDate: new Date(2026, 10, 2, 9, 0, 0) },
      NOW,
    );

    await moveTask(a.id, { status: "todo", orderIndex: 2 }, NOW);

    expect((await listTasks("today", { now: NOW })).map((t) => t.title)).toEqual([
      b.title,
      c.title,
      a.title,
    ]);
    const board = await listTasks("board");
    expect(board.todo.map((t) => [t.title, t.orderIndex])).toEqual([
      ["B", 0],
      ["C", 1],
      ["A", 2],
    ]);
    expect((await column("todo")).map((t) => [t.title, t.orderIndex])).toEqual([
      ["B", 0],
      ["C", 1],
      ["A", 2],
    ]);
  });

  it("overdue / undated 组同样按 orderIndex 排序（Issue #52）", async () => {
    const overdueRecent = await createTask(
      { title: "逾期-较近", dueDate: new Date(2026, 10, 1, 20, 0, 0) },
      NOW,
    );
    const overdueOld = await createTask(
      { title: "逾期-较早", dueDate: new Date(2026, 9, 30, 8, 0, 0) },
      NOW,
    );
    await moveTask(overdueOld.id, { status: "todo", orderIndex: 0 }, NOW);
    expect((await listTasks("overdue", { now: NOW })).map((t) => t.title)).toEqual([
      overdueOld.title,
      overdueRecent.title,
    ]);

    const undatedFirst = await createTask({ title: "待安排-1" }, NOW);
    const undatedSecond = await createTask({ title: "待安排-2" }, NOW);
    await moveTask(undatedSecond.id, { status: "todo", orderIndex: 0 }, NOW);
    expect((await listTasks("undated", { now: NOW })).map((t) => t.title)).toEqual([
      undatedSecond.title,
      undatedFirst.title,
    ]);
  });

  it("project 视图只返回该项目任务，按 todo→doing→done 排序", async () => {
    const p1 = await createProject("项目一");
    const p2 = await createProject("项目二");
    await createTask({ title: "p1-done", projectId: p1.id, status: "done" }, NOW);
    await createTask({ title: "p1-doing", projectId: p1.id, status: "doing" }, NOW);
    await createTask({ title: "p1-todo", projectId: p1.id }, NOW);
    await createTask({ title: "p2-todo", projectId: p2.id }, NOW);
    await createTask({ title: "无项目" }, NOW);

    const rows = await listTasks("project", { projectId: p1.id });
    expect(rows.map((t) => t.title)).toEqual(["p1-todo", "p1-doing", "p1-done"]);
  });

  it("拒绝缺少参数与未知视图", async () => {
    await expect(listTasks("today", {} as never)).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "now",
    });
    await expect(listTasks("project", {} as never)).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "projectId",
    });
    await expect(listTasks("someday" as never, { now: NOW })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
  });
});
