// 看板拖拽换算纯逻辑的单测（Issue #31）：
// 「拖拽事件 → 目标状态 + 目标下标」（同列上移/下移、跨列首/中/尾、拖到空列、拖到自己原位）、
// 乐观重排结果，以及与 lib/domain computeMove 插入语义的一致性交叉验证。

import { describe, expect, it } from "vitest";

import {
  columnDroppableId,
  computeDragTarget,
  isOverdue,
  moveTaskInColumns,
  type KanbanColumns,
} from "@/components/kanban-form";
import {
  computeMove,
  TASK_STATUSES,
  type BoardTaskRef,
} from "@/lib/domain/task";

/** 测试用列数据：todo 3 张、doing 2 张、done 1 张。 */
function testColumns(): KanbanColumns {
  const card = (id: string) => ({ id, title: `任务 ${id}`, priority: "medium", dueDate: null, overdue: false });
  return {
    todo: ["t1", "t2", "t3"].map(card),
    doing: ["d1", "d2"].map(card),
    done: ["x1"].map(card),
  };
}

function idColumnsOf(columns: KanbanColumns) {
  return {
    todo: columns.todo.map((card) => card.id),
    doing: columns.doing.map((card) => card.id),
    done: columns.done.map((card) => card.id),
  };
}

describe("computeDragTarget：同列", () => {
  const columns = testColumns();
  const idColumns = idColumnsOf(columns);

  it("同列下移：拖 t1 到 t3 上 → 插入下标 2", () => {
    expect(computeDragTarget(idColumns, "t1", "t3")).toEqual({ status: "todo", orderIndex: 2 });
  });

  it("同列上移：拖 t3 到 t1 上 → 插入下标 0", () => {
    expect(computeDragTarget(idColumns, "t3", "t1")).toEqual({ status: "todo", orderIndex: 0 });
  });

  it("同列相邻：拖 t2 到 t3 上 → 插入下标 2", () => {
    expect(computeDragTarget(idColumns, "t2", "t3")).toEqual({ status: "todo", orderIndex: 2 });
  });

  it("拖到自己原位（落点是自身）→ null，不发请求", () => {
    expect(computeDragTarget(idColumns, "t1", "t1")).toBeNull();
  });

  it("拖回自己所在列的列尾空白 → null（容器落点视为原位）", () => {
    expect(computeDragTarget(idColumns, "t1", columnDroppableId("todo"))).toBeNull();
  });
});

describe("computeDragTarget：跨列", () => {
  const columns = testColumns();
  const idColumns = idColumnsOf(columns);

  it("跨列首：拖 t2 到 doing 的 d1 上 → orderIndex 0", () => {
    expect(computeDragTarget(idColumns, "t2", "d1")).toEqual({ status: "doing", orderIndex: 0 });
  });

  it("跨列中：拖 t1 到 doing 的 d2 上 → orderIndex 1", () => {
    expect(computeDragTarget(idColumns, "t1", "d2")).toEqual({ status: "doing", orderIndex: 1 });
  });

  it("跨列尾：拖 t1 到 doing 列的空白容器 → 追加到列尾", () => {
    expect(computeDragTarget(idColumns, "t1", columnDroppableId("doing"))).toEqual({
      status: "doing",
      orderIndex: 2,
    });
  });

  it("拖到空列（容器是唯一落点）→ orderIndex 0", () => {
    const emptyDoing = idColumnsOf({ ...columns, doing: [] });
    expect(computeDragTarget(emptyDoing, "t1", columnDroppableId("doing"))).toEqual({
      status: "doing",
      orderIndex: 0,
    });
  });

  it("拖入 done 再拖出 done 都走同一换算（取消完成由接口负责）", () => {
    expect(computeDragTarget(idColumns, "x1", "t2")).toEqual({ status: "todo", orderIndex: 1 });
    expect(computeDragTarget(idColumns, "t1", "x1")).toEqual({ status: "done", orderIndex: 0 });
  });
});

describe("computeDragTarget：无落点 / 未知落点", () => {
  const idColumns = idColumnsOf(testColumns());

  it("over 为 null → null", () => {
    expect(computeDragTarget(idColumns, "t1", null)).toBeNull();
    expect(computeDragTarget(idColumns, "t1", undefined)).toBeNull();
  });

  it("落点 id 既不是卡片也不是列容器 → null", () => {
    expect(computeDragTarget(idColumns, "t1", "not-a-card")).toBeNull();
  });

  it("被拖任务不在看板数据里 → null", () => {
    expect(computeDragTarget(idColumns, "ghost", "t2")).toBeNull();
  });
});

describe("moveTaskInColumns：乐观重排", () => {
  it("跨列移动：t1 移到 doing 下标 1", () => {
    const next = moveTaskInColumns(testColumns(), "t1", { status: "doing", orderIndex: 1 });
    expect(next.todo.map((card) => card.id)).toEqual(["t2", "t3"]);
    expect(next.doing.map((card) => card.id)).toEqual(["d1", "t1", "d2"]);
    expect(next.done.map((card) => card.id)).toEqual(["x1"]);
  });

  it("同列移动：t1 移到下标 2", () => {
    const next = moveTaskInColumns(testColumns(), "t1", { status: "todo", orderIndex: 2 });
    expect(next.todo.map((card) => card.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("越界下标收敛到列边界（负数 → 首位，超出 → 列尾）", () => {
    const clampedLow = moveTaskInColumns(testColumns(), "t3", { status: "doing", orderIndex: -5 });
    expect(clampedLow.doing.map((card) => card.id)).toEqual(["t3", "d1", "d2"]);
    const clampedHigh = moveTaskInColumns(testColumns(), "t3", { status: "doing", orderIndex: 99 });
    expect(clampedHigh.doing.map((card) => card.id)).toEqual(["d1", "d2", "t3"]);
  });

  it("不修改入参（返回新数组）", () => {
    const columns = testColumns();
    moveTaskInColumns(columns, "t1", { status: "doing", orderIndex: 0 });
    expect(columns.todo.map((card) => card.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("被拖任务不在数据里 → 原样返回，不丢卡", () => {
    const columns = testColumns();
    expect(moveTaskInColumns(columns, "ghost", { status: "doing", orderIndex: 0 })).toBe(columns);
  });
});

describe("与 lib/domain computeMove 的插入语义一致（Issue #31 交叉验证）", () => {
  /**
   * 把 computeMove 计划的净效果应用到“id 列表”上：目标列在 plan.orderIndex 处插入
   * 被移动任务、源列移除该任务（plan.reorder 只是这两步在数据库层的差量，
   * 净效果与“插入 + 移除”一一对应）。得到接口落库后的排布。
   */
  function applyPlanToIdColumns(
    idColumns: Record<(typeof TASK_STATUSES)[number], string[]>,
    movingId: string,
    plan: ReturnType<typeof computeMove>,
  ): Record<(typeof TASK_STATUSES)[number], string[]> {
    const next: Record<(typeof TASK_STATUSES)[number], string[]> = {
      todo: [...idColumns.todo],
      doing: [...idColumns.doing],
      done: [...idColumns.done],
    };
    const from = TASK_STATUSES.find((status) => next[status].includes(movingId));
    if (from) next[from] = next[from].filter((id) => id !== movingId);
    const target = next[plan.status];
    target.splice(Math.min(plan.orderIndex, target.length), 0, movingId);
    return next;
  }

  const scenarios = [
    { name: "同列下移", moving: "t1", target: { status: "todo", orderIndex: 2 } },
    { name: "同列上移", moving: "t3", target: { status: "todo", orderIndex: 0 } },
    { name: "跨列首", moving: "t2", target: { status: "doing", orderIndex: 0 } },
    { name: "跨列中", moving: "t1", target: { status: "doing", orderIndex: 1 } },
    { name: "跨列尾", moving: "t1", target: { status: "doing", orderIndex: 2 } },
    { name: "拖到空列", moving: "t1", target: { status: "done", orderIndex: 1 } },
    { name: "取消完成（done → todo）", moving: "x1", target: { status: "todo", orderIndex: 1 } },
  ] as const;

  for (const scenario of scenarios) {
    it(`场景「${scenario.name}」：前端换算的落库结果与 computeMove 计划一致`, () => {
      const columns = testColumns();
      const idColumns = idColumnsOf(columns);

      const frontend = moveTaskInColumns(columns, scenario.moving, { ...scenario.target });
      expect(idColumnsOf(frontend)).toEqual(
        applyPlanToIdColumns(
          idColumns,
          scenario.moving,
          computeMove(toBoardTaskRefs(idColumns), scenario.moving, {
            status: scenario.target.status,
            position: scenario.target.orderIndex,
          }),
        ),
      );
    });
  }

  function toBoardTaskRefs(idColumns: Record<(typeof TASK_STATUSES)[number], string[]>): BoardTaskRef[] {
    return TASK_STATUSES.flatMap((status) =>
      idColumns[status].map((id, orderIndex) => ({ id, status, orderIndex })),
    );
  }
});

describe("isOverdue", () => {
  const now = new Date(2026, 10, 3, 15, 30); // 2026-11-03 15:30

  it("null 不逾期", () => {
    expect(isOverdue(null, now)).toBe(false);
  });

  it("昨天 23:59 逾期", () => {
    expect(isOverdue(new Date(2026, 10, 2, 23, 59), now)).toBe(true);
  });

  it("今天 00:00 起不算逾期（与 classifyForToday 同一边界）", () => {
    expect(isOverdue(new Date(2026, 10, 3, 0, 0), now)).toBe(false);
    expect(isOverdue(new Date(2026, 10, 3, 8, 0), now)).toBe(false);
  });

  it("未来日期不逾期", () => {
    expect(isOverdue(new Date(2026, 10, 4, 0, 0), now)).toBe(false);
  });
});
