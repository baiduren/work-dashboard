import { describe, expect, it } from "vitest";

import {
  applyStatusChange,
  classifyForToday,
  clampPosition,
  computeColumnInsert,
  computeMove,
  DEFAULT_TASK_PRIORITY,
  endOfDay,
  normalizeNewTask,
  normalizePriority,
  normalizeTaskPatch,
  parseDueDate,
  parseNotes,
  parseOrderIndex,
  parsePriority,
  parseProjectId,
  parseStatus,
  parseTitle,
  startOfDay,
  TaskValidationError,
  type BoardTaskRef,
} from "../lib/domain/task";

// 任务领域逻辑单测（Issue #16「范围 1」）：合法值校验、completedAt 语义、
// 看板排序计算、今日归类边界。日期边界统一用本地时区构造，注入 now 保证可复现。

function expectValidationError(fn: () => unknown, field?: string): TaskValidationError {
  try {
    fn();
  } catch (error) {
    expect(error, "应抛出 TaskValidationError").toBeInstanceOf(TaskValidationError);
    const validationError = error as TaskValidationError;
    expect(validationError.name).toBe("TaskValidationError");
    if (field !== undefined) expect(validationError.field).toBe(field);
    return validationError;
  }
  throw new Error("期望抛出 TaskValidationError，但没有抛出");
}

// 2026-11-02（周一）本地 12:00，作为“今天”的基准时刻。
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);

describe("parseStatus", () => {
  it("接受三个合法状态", () => {
    expect(parseStatus("todo")).toBe("todo");
    expect(parseStatus("doing")).toBe("doing");
    expect(parseStatus("done")).toBe("done");
  });

  it("拒绝非法值并抛出可识别错误", () => {
    for (const invalid of [undefined, null, "", "TODO", "done ", "todo1", 1, true, {}, []]) {
      expectValidationError(() => parseStatus(invalid), "status");
    }
  });
});

describe("priority 校验", () => {
  it("parsePriority 接受三个合法优先级", () => {
    expect(parsePriority("low")).toBe("low");
    expect(parsePriority("medium")).toBe("medium");
    expect(parsePriority("high")).toBe("high");
  });

  it("parsePriority 拒绝非法值", () => {
    for (const invalid of [undefined, null, "", "urgent", "MEDIUM", 0, {}]) {
      expectValidationError(() => parsePriority(invalid), "priority");
    }
  });

  it("normalizePriority 缺省为 medium", () => {
    expect(DEFAULT_TASK_PRIORITY).toBe("medium");
    expect(normalizePriority(undefined)).toBe("medium");
    expect(normalizePriority(null)).toBe("medium");
    expect(normalizePriority("high")).toBe("high");
  });
});

describe("字段校验", () => {
  it("parseTitle 裁剪首尾空白，拒绝空标题", () => {
    expect(parseTitle("  写周报 ")).toBe("写周报");
    for (const invalid of [undefined, null, "", "   ", 42]) {
      expectValidationError(() => parseTitle(invalid), "title");
    }
  });

  it("parseNotes 接受字符串与 null", () => {
    expect(parseNotes(undefined)).toBeNull();
    expect(parseNotes(null)).toBeNull();
    expect(parseNotes("备注")).toBe("备注");
    expect(parseNotes("")).toBe("");
    expectValidationError(() => parseNotes(1), "notes");
  });

  it("parseDueDate 接受 Date、日期字符串与 null，拒绝无法解析的值", () => {
    const date = new Date(2026, 10, 2, 9, 0, 0);
    expect(parseDueDate(undefined)).toBeNull();
    expect(parseDueDate(null)).toBeNull();
    expect(parseDueDate(date)).toBe(date);
    expect(parseDueDate("2026-11-02T09:00:00")).toEqual(date);
    expectValidationError(() => parseDueDate("not-a-date"), "dueDate");
    expectValidationError(() => parseDueDate(new Date("not-a-date")), "dueDate");
    expectValidationError(() => parseDueDate(1762000000000), "dueDate");
  });

  it("parseProjectId 空串与纯空白视为无项目", () => {
    expect(parseProjectId(undefined)).toBeNull();
    expect(parseProjectId(null)).toBeNull();
    expect(parseProjectId("")).toBeNull();
    expect(parseProjectId("  ")).toBeNull();
    expect(parseProjectId("proj-1")).toBe("proj-1");
    expectValidationError(() => parseProjectId(7), "projectId");
  });

  it("parseOrderIndex 只接受整数", () => {
    expect(parseOrderIndex(0)).toBe(0);
    expect(parseOrderIndex(3)).toBe(3);
    for (const invalid of [undefined, null, 1.5, "2", NaN, Infinity]) {
      expectValidationError(() => parseOrderIndex(invalid), "orderIndex");
    }
  });

  it("clampPosition 把位置收敛到 [0, upperBound]", () => {
    expect(clampPosition(-5, 3)).toBe(0);
    expect(clampPosition(2, 3)).toBe(2);
    expect(clampPosition(99, 3)).toBe(3);
    expectValidationError(() => clampPosition(1.5, 3), "orderIndex");
  });
});

describe("normalizeNewTask", () => {
  it("仅标题时应用全部缺省值", () => {
    expect(normalizeNewTask({ title: " 买菜 " })).toEqual({
      title: "买菜",
      notes: null,
      status: "todo",
      priority: "medium",
      dueDate: null,
      projectId: null,
      orderIndex: undefined,
    });
  });

  it("完整输入逐字段归一化", () => {
    const dueDate = "2026-11-05T18:00:00";
    const normalized = normalizeNewTask({
      title: "交付演示",
      notes: "带投影仪",
      status: "doing",
      priority: "high",
      dueDate,
      projectId: "proj-1",
      orderIndex: 2,
    });
    expect(normalized.title).toBe("交付演示");
    expect(normalized.status).toBe("doing");
    expect(normalized.priority).toBe("high");
    expect(normalized.dueDate).toEqual(new Date(dueDate));
    expect(normalized.projectId).toBe("proj-1");
    expect(normalized.orderIndex).toBe(2);
  });

  it("拒绝非法输入与非对象输入", () => {
    expectValidationError(() => normalizeNewTask({ title: "x", status: "paused" }), "status");
    expectValidationError(() => normalizeNewTask({ title: "x", priority: "urgent" }), "priority");
    expectValidationError(() => normalizeNewTask({ title: "" }), "title");
    expectValidationError(() => normalizeNewTask({ title: "x", orderIndex: 1.5 }), "orderIndex");
    expectValidationError(() => normalizeNewTask(null), "input");
    expectValidationError(() => normalizeNewTask("task"), "input");
    expectValidationError(() => normalizeNewTask([1]), "input");
  });
});

describe("normalizeTaskPatch", () => {
  it("空补丁保持为空", () => {
    expect(normalizeTaskPatch({})).toEqual({});
  });

  it("只挑选可更新字段，忽略其余字段（含 status）", () => {
    expect(
      normalizeTaskPatch({ title: "新标题", status: "done", id: "t1", extra: true }),
    ).toEqual({ title: "新标题" });
  });

  it("未提供的字段不出现在结果中，显式 null 表示清空", () => {
    const patch = normalizeTaskPatch({ dueDate: null, projectId: null, notes: null });
    expect(patch).toEqual({ dueDate: null, projectId: null, notes: null });
    expect("title" in patch).toBe(false);
  });

  it("校验提供的字段", () => {
    expect(normalizeTaskPatch({ priority: "low" })).toEqual({ priority: "low" });
    expectValidationError(() => normalizeTaskPatch({ priority: null }), "priority");
    expectValidationError(() => normalizeTaskPatch({ title: "  " }), "title");
    expectValidationError(() => normalizeTaskPatch({ dueDate: "abc" }), "dueDate");
    expectValidationError(() => normalizeTaskPatch(42), "patch");
    expectValidationError(() => normalizeTaskPatch(null), "patch");
  });
});

describe("applyStatusChange", () => {
  const NOW_DONE = new Date(2026, 10, 2, 18, 0, 0);

  it("进入 done 写入 completedAt", () => {
    expect(applyStatusChange({ status: "todo", completedAt: null }, "done", NOW_DONE)).toEqual({
      status: "done",
      completedAt: NOW_DONE,
    });
    expect(applyStatusChange({ status: "doing", completedAt: null }, "done", NOW_DONE)).toEqual({
      status: "done",
      completedAt: NOW_DONE,
    });
  });

  it("离开 done 清空 completedAt（取消完成同样合法）", () => {
    const done = { status: "done" as const, completedAt: new Date(2026, 10, 1) };
    expect(applyStatusChange(done, "todo", NOW_DONE)).toEqual({ status: "todo", completedAt: null });
    expect(applyStatusChange(done, "doing", NOW_DONE)).toEqual({
      status: "doing",
      completedAt: null,
    });
  });

  it("done → done 保留原 completedAt，不重复计时", () => {
    const completedAt = new Date(2026, 10, 1, 9, 0, 0);
    expect(
      applyStatusChange({ status: "done", completedAt }, "done", NOW_DONE),
    ).toEqual({ status: "done", completedAt });
  });

  it("done → done 且历史 completedAt 缺失时补 now", () => {
    expect(applyStatusChange({ status: "done", completedAt: null }, "done", NOW_DONE)).toEqual({
      status: "done",
      completedAt: NOW_DONE,
    });
  });

  it("不经过 done 的切换不携带完成时间", () => {
    expect(applyStatusChange({ status: "todo", completedAt: null }, "doing", NOW_DONE)).toEqual({
      status: "doing",
      completedAt: null,
    });
    expect(applyStatusChange({ status: "doing", completedAt: null }, "todo", NOW_DONE)).toEqual({
      status: "todo",
      completedAt: null,
    });
  });
});

describe("startOfDay / endOfDay", () => {
  it("给出当天的首毫秒与最后一毫秒", () => {
    const now = new Date(2026, 10, 2, 15, 30, 45, 123);
    expect(startOfDay(now)).toEqual(new Date(2026, 10, 2, 0, 0, 0, 0));
    expect(endOfDay(now)).toEqual(new Date(2026, 10, 2, 23, 59, 59, 999));
  });
});

describe("classifyForToday", () => {
  const today = (hour: number, minute = 0, ms = 0): Date =>
    new Date(2026, 10, 2, hour, minute, 0, ms);

  it("今天 00:00 到 23:59:59.999 之间算 today（含边界）", () => {
    for (const dueDate of [today(0), today(12), today(23, 59, 999)]) {
      expect(classifyForToday({ dueDate, status: "todo" }, NOW)).toBe("today");
    }
  });

  it("早于今天开始（含昨天 23:59:59.999）算 overdue", () => {
    for (const dueDate of [new Date(2026, 10, 1, 23, 59, 59, 999), new Date(2026, 9, 1)]) {
      expect(classifyForToday({ dueDate, status: "todo" }, NOW)).toBe("overdue");
    }
  });

  it("dueDate 为空算 undated，未来日期不属于任何分组", () => {
    expect(classifyForToday({ dueDate: null, status: "todo" }, NOW)).toBe("undated");
    expect(classifyForToday({ dueDate: new Date(2026, 10, 3, 0, 0, 0, 0), status: "todo" }, NOW)).toBeNull();
    expect(classifyForToday({ dueDate: new Date(2027, 0, 1), status: "doing" }, NOW)).toBeNull();
  });

  it("已完成的任务不属于任何分组", () => {
    expect(classifyForToday({ dueDate: today(9), status: "done" }, NOW)).toBeNull();
    expect(classifyForToday({ dueDate: new Date(2026, 10, 1), status: "done" }, NOW)).toBeNull();
    expect(classifyForToday({ dueDate: null, status: "done" }, NOW)).toBeNull();
  });

  it("边界随注入时间滚动：午夜前后同一任务从 today 变为 overdue", () => {
    const dueDate = new Date(2026, 10, 2, 20, 0, 0);
    expect(classifyForToday({ dueDate, status: "todo" }, new Date(2026, 10, 2, 23, 59, 59, 999))).toBe("today");
    expect(classifyForToday({ dueDate, status: "todo" }, new Date(2026, 10, 3, 0, 0, 0, 0))).toBe("overdue");
  });
});

// ---------------------------------------------------------------------------
// 看板排序计算
// ---------------------------------------------------------------------------

function ref(id: string, status: BoardTaskRef["status"], orderIndex: number): BoardTaskRef {
  return { id, status, orderIndex };
}

describe("computeColumnInsert", () => {
  it("空列插入得到 0，无重排", () => {
    expect(computeColumnInsert([], 0)).toEqual({ orderIndex: 0, reorder: [] });
  });

  it("插入中部时后续任务整体后移", () => {
    const column = [ref("a", "todo", 0), ref("b", "todo", 1), ref("c", "todo", 2)];
    expect(computeColumnInsert(column, 1)).toEqual({
      orderIndex: 1,
      reorder: [
        { id: "b", orderIndex: 2 },
        { id: "c", orderIndex: 3 },
      ],
    });
  });

  it("追加到列尾不影响现有任务", () => {
    const column = [ref("a", "todo", 0), ref("b", "todo", 1)];
    expect(computeColumnInsert(column, 2)).toEqual({ orderIndex: 2, reorder: [] });
  });

  it("越界位置收敛到边界", () => {
    const column = [ref("a", "todo", 0)];
    expect(computeColumnInsert(column, -3).orderIndex).toBe(0);
    expect(computeColumnInsert(column, 9).orderIndex).toBe(1);
  });

  it("稀疏 orderIndex 的列插入后仍连续无重复", () => {
    const column = [ref("a", "todo", 0), ref("b", "todo", 5), ref("c", "todo", 6)];
    const plan = computeColumnInsert(column, 1);
    expect(plan.orderIndex).toBe(1);
    expect(plan.reorder).toEqual([
      { id: "b", orderIndex: 2 },
      { id: "c", orderIndex: 3 },
    ]);
  });
});

describe("computeMove", () => {
  it("同列移动：目标列重排为 0..n-1 且无重复", () => {
    const board = [
      ref("a", "todo", 0),
      ref("b", "todo", 1),
      ref("c", "todo", 2),
      ref("d", "todo", 3),
      ref("e", "doing", 0),
    ];
    const plan = computeMove(board, "d", { status: "todo", position: 0 });
    expect(plan).toEqual({
      taskId: "d",
      status: "todo",
      orderIndex: 0,
      reorder: [
        { id: "a", orderIndex: 1 },
        { id: "b", orderIndex: 2 },
        { id: "c", orderIndex: 3 },
      ],
      sameColumn: true,
    });
    // 校验最终序列：d,a,b,c → 0,1,2,3
    expect([...plan.reorder.map((r) => r.orderIndex), plan.orderIndex].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
  });

  it("同列后移：只重排被跨过的任务", () => {
    const board = [ref("a", "todo", 0), ref("b", "todo", 1), ref("c", "todo", 2)];
    const plan = computeMove(board, "a", { status: "todo", position: 2 });
    expect(plan.orderIndex).toBe(2);
    expect(plan.reorder).toEqual([
      { id: "b", orderIndex: 0 },
      { id: "c", orderIndex: 1 },
    ]);
  });

  it("跨列移动：目标列插入 + 源列收紧空隙", () => {
    const board = [
      ref("a", "todo", 0),
      ref("b", "todo", 1),
      ref("c", "todo", 2),
      ref("x", "doing", 0),
      ref("y", "doing", 1),
    ];
    const plan = computeMove(board, "b", { status: "doing", position: 0 });
    expect(plan.sameColumn).toBe(false);
    expect(plan.status).toBe("doing");
    expect(plan.orderIndex).toBe(0);
    expect(plan.reorder).toEqual([
      { id: "x", orderIndex: 1 },
      { id: "y", orderIndex: 2 },
      { id: "c", orderIndex: 1 },
    ]);
  });

  it("跨列移动到空列：orderIndex 为 0，源列无实际变化则不产生 reorder", () => {
    const board = [ref("a", "todo", 0), ref("b", "todo", 1)];
    const plan = computeMove(board, "b", { status: "done", position: 0 });
    expect(plan).toEqual({
      taskId: "b",
      status: "done",
      orderIndex: 0,
      reorder: [],
      sameColumn: false,
    });
  });

  it("未变化的任务不出现在 reorder 中", () => {
    const board = [
      ref("a", "todo", 0),
      ref("b", "todo", 1),
      ref("c", "todo", 2),
      ref("d", "todo", 3),
    ];
    // 把 a 移到 1：b 前移到 0，c/d 不变
    const plan = computeMove(board, "a", { status: "todo", position: 1 });
    expect(plan.reorder).toEqual([{ id: "b", orderIndex: 0 }]);
  });

  it("位置越界时收敛到列边界", () => {
    const board = [ref("a", "todo", 0), ref("b", "todo", 1)];
    expect(computeMove(board, "b", { status: "todo", position: -1 }).orderIndex).toBe(0);
    expect(computeMove(board, "a", { status: "todo", position: 99 }).orderIndex).toBe(1);
  });

  it("拒绝未知任务、非法状态与非整数位置", () => {
    const board = [ref("a", "todo", 0)];
    expectValidationError(() => computeMove(board, "ghost", { status: "todo", position: 0 }), "id");
    expectValidationError(() => computeMove(board, "a", { status: "paused", position: 0 }), "status");
    expectValidationError(() => computeMove(board, "a", { status: "todo", position: 0.5 }), "orderIndex");
  });
});
