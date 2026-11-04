import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../lib/db";
import {
  createTask,
  deleteTask,
  getTask,
  type TaskRecord,
} from "../lib/db/tasks";
import {
  applyTaskTagsInTx,
  createTag,
  deleteTag,
  listTags,
  setTaskTags,
  TagNotFoundError,
  updateTag,
} from "../lib/db/tags";
import { TagValidationError } from "../lib/domain/tag";
import { TaskValidationError } from "../lib/domain/task";
import type { Prisma } from "@prisma/client";

// 标签数据访问层集成测试（Issue #39「范围 2」）。
// 使用临时 SQLite 文件 + prisma migrate deploy，不依赖也不触碰 prisma/dev.db；
// DATABASE_URL 必须在 lib/db 模块求值（实例化 PrismaClient）之前指向临时库，
// 因此用 vi.hoisted 在静态 import 之前完成设置。每个用例前后清理数据。

const tempDb = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-dashboard-tag-db-"));
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

async function seedTask(title = "任务A"): Promise<TaskRecord> {
  return createTask({ title }, NOW);
}

describe("createTag", () => {
  it("创建标签：name 裁剪、color 缺省 null、显式 color 落库", async () => {
    const plain = await createTag({ name: "  紧急  " });
    expect(plain.name).toBe("紧急");
    expect(plain.color).toBeNull();
    expect(typeof plain.id).toBe("string");

    const colored = await createTag({ name: "周会", color: "#22c55e" });
    expect(colored.color).toBe("#22c55e");
  });

  it("重名创建抛 TagValidationError（固定文案「标签名已存在」，可映射 400）", async () => {
    await createTag({ name: "紧急" });
    await expect(createTag({ name: "紧急" })).rejects.toMatchObject({
      name: "TagValidationError",
      field: "name",
      message: "标签名已存在",
    });
    await expect(createTag({ name: "  紧急 " })).rejects.toBeInstanceOf(TagValidationError);
    // TagValidationError 是 TaskValidationError 子类：现有 toErrorResponse 映射为 400
    await expect(createTag({ name: "紧急" })).rejects.toBeInstanceOf(TaskValidationError);
    expect(await prisma.tag.count()).toBe(1);
  });

  it("非法 name / color 抛 TaskValidationError 且不落库", async () => {
    for (const input of [{ name: "" }, { name: "   " }, { name: "x".repeat(25) }, { name: "ok", color: "red" }, { name: "ok", color: "#12345" }]) {
      await expect(createTag(input)).rejects.toBeInstanceOf(TaskValidationError);
    }
    expect(await prisma.tag.count()).toBe(0);
  });
});

describe("listTags", () => {
  it("空库返回 []；按 name 升序", async () => {
    expect(await listTags()).toEqual([]);
    await createTag({ name: "周会" });
    await createTag({ name: "紧急" });
    await createTag({ name: "低优先" });
    expect((await listTags()).map((tag) => tag.name)).toEqual(["低优先", "周会", "紧急"]);
  });
});

describe("updateTag", () => {
  it("改名与改色生效；显式 color=null 清空颜色", async () => {
    const tag = await createTag({ name: "旧名", color: "#ef4444" });
    const renamed = await updateTag(tag.id, { name: "新名", color: "#3b82f6" });
    expect(renamed.name).toBe("新名");
    expect(renamed.color).toBe("#3b82f6");

    const cleared = await updateTag(tag.id, { color: null });
    expect(cleared.color).toBeNull();
    expect(cleared.name).toBe("新名");
  });

  it("空补丁原样返回", async () => {
    const tag = await createTag({ name: "原样", color: "#ef4444" });
    const same = await updateTag(tag.id, {});
    expect(same.name).toBe("原样");
    expect(same.color).toBe("#ef4444");
  });

  it("改名撞唯一约束 → TagValidationError「标签名已存在」；不存在 → TagNotFoundError", async () => {
    await createTag({ name: "甲" });
    const tag = await createTag({ name: "乙" });
    await expect(updateTag(tag.id, { name: "甲" })).rejects.toMatchObject({
      name: "TagValidationError",
      message: "标签名已存在",
    });
    await expect(updateTag("no-such-id", { name: "丙" })).rejects.toBeInstanceOf(TagNotFoundError);
  });

  it("非法字段值抛 TaskValidationError", async () => {
    const tag = await createTag({ name: "紧急" });
    await expect(updateTag(tag.id, { name: "" })).rejects.toBeInstanceOf(TaskValidationError);
    await expect(updateTag(tag.id, { color: "red" })).rejects.toBeInstanceOf(TaskValidationError);
    expect((await listTags())[0]?.name).toBe("紧急");
  });
});

describe("deleteTag", () => {
  it("删除标签后 TaskTag 级联清空，任务本身保留", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await setTaskTags(task.id, [tag.id]);
    expect(await prisma.taskTag.count()).toBe(1);

    await deleteTag(tag.id);
    expect(await prisma.tag.count()).toBe(0);
    expect(await prisma.taskTag.count()).toBe(0); // 级联删除
    const after = await getTask(task.id);
    expect(after).not.toBeNull();
    expect(after?.tags).toEqual([]);
  });

  it("删除任务同样级联清空 TaskTag，标签保留", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await setTaskTags(task.id, [tag.id]);

    await deleteTask(task.id);
    expect(await prisma.taskTag.count()).toBe(0);
    expect((await listTags()).map((t) => t.name)).toEqual(["紧急"]);
  });

  it("标签不存在 → TagNotFoundError", async () => {
    await expect(deleteTag("no-such-id")).rejects.toBeInstanceOf(TagNotFoundError);
  });
});

describe("setTaskTags", () => {
  it("绑定多个标签：getTask 返回按标签名升序的 tags 摘要", async () => {
    const task = await seedTask();
    const urgent = await createTag({ name: "紧急" });
    const weekly = await createTag({ name: "周会" });
    await setTaskTags(task.id, [urgent.id, weekly.id]);

    const after = await getTask(task.id);
    expect(after?.tags).toEqual([
      { id: weekly.id, name: "周会", color: null },
      { id: urgent.id, name: "紧急", color: null },
    ]);
  });

  it("再次 setTaskTags 全量替换：解绑与换绑生效", async () => {
    const task = await seedTask();
    const urgent = await createTag({ name: "紧急" });
    const weekly = await createTag({ name: "周会" });
    const focus = await createTag({ name: "专注" });
    await setTaskTags(task.id, [urgent.id, weekly.id]);

    // 换绑：去掉周会，加入专注
    await setTaskTags(task.id, [urgent.id, focus.id]);
    const after = await getTask(task.id);
    expect(after?.tags.map((tag) => tag.name).sort()).toEqual(["专注", "紧急"].sort());

    // 空数组 = 全部解绑
    await setTaskTags(task.id, []);
    expect((await getTask(task.id))?.tags).toEqual([]);
  });

  it("重复 tagId 去重绑定一次（复合主键不允许重复）", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await setTaskTags(task.id, [tag.id, tag.id, `  ${tag.id}  `]);
    expect(await prisma.taskTag.count()).toBe(1);
  });

  it("不存在的 tagId → TaskValidationError（message 指明 id），不产生半绑定", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await expect(setTaskTags(task.id, [tag.id, "no-such-tag"])).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "tagIds",
      message: "标签不存在：no-such-tag",
    });
    // 整体回滚：合法的那个 id 也没有落库
    expect(await prisma.taskTag.count()).toBe(0);
  });

  it("不存在的 taskId → TaskValidationError（message 指明 id）", async () => {
    const tag = await createTag({ name: "紧急" });
    await expect(setTaskTags("no-such-task", [tag.id])).rejects.toMatchObject({
      name: "TaskValidationError",
      field: "taskId",
      message: "任务不存在：no-such-task",
    });
  });

  it("非法 tagIds（非数组 / 含空串）→ TaskValidationError", async () => {
    const task = await seedTask();
    await expect(setTaskTags(task.id, "tag-1" as never)).rejects.toMatchObject({
      field: "tagIds",
    });
    await expect(setTaskTags(task.id, [""] as never)).rejects.toMatchObject({
      field: "tagIds",
    });
  });
});

describe("applyTaskTagsInTx", () => {
  it("在调用方事务内生效：同一事务内的任务更新可见标签写入", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await applyTaskTagsInTx(tx, task.id, [tag.id]);
    });
    expect((await getTask(task.id))?.tags.map((t) => t.name)).toEqual(["紧急"]);
  });

  it("调用方事务回滚时标签写入一并回滚（不嵌套独立事务）", async () => {
    const task = await seedTask();
    const tag = await createTag({ name: "紧急" });
    await expect(
      prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await applyTaskTagsInTx(tx, task.id, [tag.id]);
        // 同事务内再制造一个失败：更新不存在的任务触发 P2025 → 整体回滚
        //（status 列在 SQLite 无枚举约束，非法取值不会在数据库层报错，不能用它制造失败）。
        await tx.task.update({ where: { id: "no-such-id" }, data: { title: "x" } });
      }),
    ).rejects.toBeTruthy();
    expect(await prisma.taskTag.count()).toBe(0);
  });
});
