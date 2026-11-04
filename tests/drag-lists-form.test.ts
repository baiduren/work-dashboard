// 通用拖拽排序纯逻辑的单测（Issue #52）：看板与今日视图共用的
// 「落点 → 目标列表 + 插入下标」换算与乐观重排；列表 key 在此用今日三组
// （today / overdue / undated）验证通用性，看板 status 版本由 kanban-form.test.ts 覆盖。

import { describe, expect, it } from "vitest";

import {
  computeDragTargetInLists,
  listDroppableId,
  listIdFromDroppableId,
  moveItemInLists,
} from "@/components/drag-lists-form";

function testLists() {
  const item = (id: string) => ({ id, title: `任务 ${id}` });
  return {
    today: ["a", "b", "c"].map(item),
    overdue: ["d", "e"].map(item),
    undated: [] as Array<{ id: string; title: string }>,
  };
}

function idListsOf(lists: ReturnType<typeof testLists>) {
  return {
    today: lists.today.map((entry) => entry.id),
    overdue: lists.overdue.map((entry) => entry.id),
    undated: lists.undated.map((entry) => entry.id),
  };
}

describe("listDroppableId", () => {
  it("列表 key 与 droppable id 可逆", () => {
    expect(listDroppableId("today")).toBe("column:today");
    expect(listIdFromDroppableId("column:today")).toBe("today");
    expect(listIdFromDroppableId("column:overdue")).toBe("overdue");
  });

  it("非列表容器 id（卡片 id / 空串）返回 null", () => {
    expect(listIdFromDroppableId("task-abc")).toBeNull();
    expect(listIdFromDroppableId("")).toBeNull();
  });
});

describe("computeDragTargetInLists：同列表", () => {
  const lists = testLists();
  const idLists = idListsOf(lists);

  it("下移：拖 a 到 c 上 → 插入下标 2", () => {
    expect(computeDragTargetInLists(idLists, "a", "c")).toEqual({ listId: "today", orderIndex: 2 });
  });

  it("上移：拖 c 到 a 上 → 插入下标 0", () => {
    expect(computeDragTargetInLists(idLists, "c", "a")).toEqual({ listId: "today", orderIndex: 0 });
  });

  it("拖到自己身上 → null（不发请求）", () => {
    expect(computeDragTargetInLists(idLists, "a", "a")).toBeNull();
  });

  it("拖回自己所在列表的空白容器 → null（容器落点视为原位）", () => {
    expect(computeDragTargetInLists(idLists, "a", listDroppableId("today"))).toBeNull();
  });
});

describe("computeDragTargetInLists：跨列表 / 容器", () => {
  const idLists = idListsOf(testLists());

  it("落点是别的列表容器 → 追加到该列表尾", () => {
    expect(computeDragTargetInLists(idLists, "a", listDroppableId("overdue"))).toEqual({
      listId: "overdue",
      orderIndex: 2,
    });
  });

  it("落点是空列表容器 → 下标 0", () => {
    expect(computeDragTargetInLists(idLists, "a", listDroppableId("undated"))).toEqual({
      listId: "undated",
      orderIndex: 0,
    });
  });

  it("落点是别的列表里的条目 → 该条目在目标列表的下标", () => {
    expect(computeDragTargetInLists(idLists, "a", "e")).toEqual({
      listId: "overdue",
      orderIndex: 1,
    });
  });
});

describe("computeDragTargetInLists：无落点 / 未知落点", () => {
  const idLists = idListsOf(testLists());

  it("over 为 null / undefined → null", () => {
    expect(computeDragTargetInLists(idLists, "a", null)).toBeNull();
    expect(computeDragTargetInLists(idLists, "a", undefined)).toBeNull();
  });

  it("落点既不是条目也不是已知列表容器 → null", () => {
    expect(computeDragTargetInLists(idLists, "a", "not-an-item")).toBeNull();
    expect(computeDragTargetInLists(idLists, "a", listDroppableId("unknown"))).toBeNull();
  });

  it("被拖条目不在数据里 → null", () => {
    expect(computeDragTargetInLists(idLists, "ghost", "b")).toBeNull();
  });
});

describe("moveItemInLists：乐观重排", () => {
  it("跨列表移动：a 移到 overdue 下标 1", () => {
    const next = moveItemInLists(testLists(), "a", { listId: "overdue", orderIndex: 1 });
    expect(next.today.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(next.overdue.map((entry) => entry.id)).toEqual(["d", "a", "e"]);
    expect(next.undated).toEqual([]);
  });

  it("同列表移动：a 移到下标 2", () => {
    const next = moveItemInLists(testLists(), "a", { listId: "today", orderIndex: 2 });
    expect(next.today.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("越界下标收敛到列表边界（负数 → 首位，超出 → 列表尾）", () => {
    const low = moveItemInLists(testLists(), "c", { listId: "overdue", orderIndex: -5 });
    expect(low.overdue.map((entry) => entry.id)).toEqual(["c", "d", "e"]);
    const high = moveItemInLists(testLists(), "c", { listId: "overdue", orderIndex: 99 });
    expect(high.overdue.map((entry) => entry.id)).toEqual(["d", "e", "c"]);
  });

  it("不修改入参（返回新数组）", () => {
    const lists = testLists();
    moveItemInLists(lists, "a", { listId: "overdue", orderIndex: 0 });
    expect(lists.today.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("被拖条目不在数据里 → 各列表原样复制，不丢条目", () => {
    const next = moveItemInLists(testLists(), "ghost", { listId: "overdue", orderIndex: 0 });
    expect(next.today.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(next.overdue.map((entry) => entry.id)).toEqual(["d", "e"]);
  });
});
