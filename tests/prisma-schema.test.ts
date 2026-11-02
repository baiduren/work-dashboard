import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 骨架阶段的契约测试：锁定 prisma/schema.prisma 与 docs/01-architecture.md
// 「数据模型（草案）」约定的模型与字段，防止骨架被意外破坏。

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

function modelSource(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, "m"));
  expect(match, `prisma/schema.prisma 应定义 model ${name}`).not.toBeNull();
  return match?.[0] ?? "";
}

function expectField(model: string, field: string): void {
  expect(
    modelSource(model),
    `model ${model} 应包含字段 ${field}`,
  ).toMatch(new RegExp(`^\\s*${field}\\s`, "m"));
}

describe("prisma/schema.prisma 数据模型", () => {
  it("使用 SQLite 数据源", () => {
    expect(schema).toMatch(/provider\s*=\s*"sqlite"/);
  });

  it("Project 模型包含架构文档约定的字段", () => {
    for (const field of ["id", "name", "color", "archived"]) {
      expectField("Project", field);
    }
  });

  it("Task 模型包含架构文档约定的字段", () => {
    for (const field of [
      "id",
      "title",
      "notes",
      "status",
      "priority",
      "dueDate",
      "projectId",
      "orderIndex",
      "createdAt",
      "updatedAt",
      "completedAt",
    ]) {
      expectField("Task", field);
    }
  });

  it("Tag / TaskTag 模型包含架构文档约定的字段", () => {
    for (const field of ["id", "name", "color"]) {
      expectField("Tag", field);
    }
    for (const field of ["taskId", "tagId"]) {
      expectField("TaskTag", field);
    }
    expect(modelSource("TaskTag")).toMatch(/@@id\(\[taskId,\s*tagId\]\)/);
  });
});
