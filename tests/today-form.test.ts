// 今日视图客户端交互纯逻辑的单测（Issue #25、Issue #50、Issue #52）：
// 快速添加 payload 构造（标题裁剪/空白忽略/默认值）、本地日期格式化、
// 日期输入的清空语义；组内拖拽的落点 → /move body 换算与乐观重排。
// 取值规则来自 lib/domain/task.ts，这里验证其在 UI 层的接线。
// Issue #50 增补收件箱快速添加 payload（不带 dueDate）与行内快捷归类日期计算。

import { describe, expect, it } from "vitest";

import {
  buildInboxQuickAddPayload,
  buildQuickAddPayload,
  computeTodayMoveTarget,
  dueDateInputToPatch,
  formatLocalDate,
  formatQuickClassifyDate,
  moveTaskInTodaySection,
  type TodaySortableTask,
} from "@/components/today-form";

describe("formatLocalDate", () => {
  it("按本地时区输出 YYYY-MM-DD", () => {
    // 各字段用本地时间构造，避免测试依赖运行环境时区。
    expect(formatLocalDate(new Date(2026, 10, 3, 15, 30, 45))).toBe("2026-11-03");
  });

  it("月份与日期补零", () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("buildQuickAddPayload", () => {
  const today = new Date(2026, 10, 3, 15, 30);

  it("裁剪标题并应用默认值：dueDate=今天、priority=medium", () => {
    expect(buildQuickAddPayload("  写周报  ", today)).toEqual({
      title: "写周报",
      priority: "medium",
      dueDate: "2026-11-03",
    });
  });

  it("空标题返回 null（忽略，不发请求）", () => {
    expect(buildQuickAddPayload("", today)).toBeNull();
  });

  it("纯空白标题返回 null（忽略，不发请求）", () => {
    expect(buildQuickAddPayload("   \n\t ", today)).toBeNull();
  });
});

describe("dueDateInputToPatch", () => {
  it("空字符串映射为 null（清空截止日期）", () => {
    expect(dueDateInputToPatch("")).toBeNull();
  });

  it("日期字符串原样透传，由服务端校验可解析性", () => {
    expect(dueDateInputToPatch("2026-12-31")).toBe("2026-12-31");
  });
});

// 组内拖拽（Issue #52）：今日组内顺序复用 orderIndex，移动请求与看板同构
// （body { status, orderIndex }，插入下标语义为“移除被拖任务后的下标”）。
function task(id: string, status: string): TodaySortableTask {
  return { id, status };
}

describe("moveTaskInTodaySection", () => {
  const tasks = [task("a", "todo"), task("b", "todo"), task("c", "todo")];

  it("同组下移：a 落到下标 2 → [b, c, a]", () => {
    expect(moveTaskInTodaySection(tasks, "a", 2).map((entry) => entry.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("同组上移：c 落到下标 0 → [c, a, b]", () => {
    expect(moveTaskInTodaySection(tasks, "c", 0).map((entry) => entry.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("越界下标收敛到组边界，不修改入参", () => {
    expect(moveTaskInTodaySection(tasks, "a", 99).map((entry) => entry.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(moveTaskInTodaySection(tasks, "c", -5).map((entry) => entry.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(tasks.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

describe("computeTodayMoveTarget", () => {
  it("同 status 组：落点下标直接换算成该 status 列内插入下标（不移除自身时）", () => {
    const tasks = [task("a", "todo"), task("b", "todo"), task("c", "todo")];
    expect(computeTodayMoveTarget(tasks, "a", 2)).toEqual({ status: "todo", orderIndex: 2 });
    expect(computeTodayMoveTarget(tasks, "c", 0)).toEqual({ status: "todo", orderIndex: 0 });
    expect(computeTodayMoveTarget(tasks, "b", 1)).toEqual({ status: "todo", orderIndex: 1 });
  });

  it("混合 status 组：目标列保持任务自身 status，下标 = 落点前同 status 任务数", () => {
    // 组内展示顺序 a(todo) / b(doing) / c(todo)；把 c 拖到最前：
    // todo 列内它在 a 之前 → orderIndex 0；doing 任务的 status 不变。
    const tasks = [task("a", "todo"), task("b", "doing"), task("c", "todo")];
    expect(computeTodayMoveTarget(tasks, "c", 0)).toEqual({ status: "todo", orderIndex: 0 });
    // 把 a 拖到 b 与 c 之间：落点前没有 todo 任务 → todo 列内 orderIndex 0。
    expect(computeTodayMoveTarget(tasks, "a", 1)).toEqual({ status: "todo", orderIndex: 0 });
  });

  it("doing 任务只在自己 status 列内换算（不因组内落点改成 todo）", () => {
    const tasks = [task("a", "todo"), task("b", "doing"), task("c", "doing")];
    expect(computeTodayMoveTarget(tasks, "c", 0)).toEqual({ status: "doing", orderIndex: 0 });
  });

  it("被拖任务不在组内 / status 非法 / 越界下标 → 安全返回", () => {
    expect(computeTodayMoveTarget([task("a", "todo")], "ghost", 0)).toBeNull();
    expect(computeTodayMoveTarget([task("a", "paused")], "a", 0)).toBeNull();
    expect(computeTodayMoveTarget([task("a", "todo")], "a", 99)).toEqual({
      status: "todo",
      orderIndex: 0,
    });
  });
});

describe("buildInboxQuickAddPayload（Issue #50）", () => {
  it("只带标题与默认优先级：payload 不含 dueDate（不传即无日期）", () => {
    const payload = buildInboxQuickAddPayload("  记下想法  ");
    expect(payload).toEqual({ title: "记下想法", priority: "medium" });
    // 显式断言请求体没有 dueDate 字段：这是与今日快速添加的唯一差异。
    expect(payload !== null && "dueDate" in payload).toBe(false);
  });

  it("空标题返回 null（忽略，不发请求）", () => {
    expect(buildInboxQuickAddPayload("")).toBeNull();
  });

  it("纯空白标题返回 null（忽略，不发请求）", () => {
    expect(buildInboxQuickAddPayload("   \n\t ")).toBeNull();
  });
});

describe("formatQuickClassifyDate（Issue #50）", () => {
  // 2026-11-02 是周一，2026-11-04 是周三，2026-11-08 是周日（全部本地时区构造）。
  const wednesday = new Date(2026, 10, 4, 15, 30);

  it("today 输出本地当天 YYYY-MM-DD", () => {
    expect(formatQuickClassifyDate("today", wednesday)).toBe("2026-11-04");
  });

  it("tomorrow 为次日，跨月由 Date 自动进位", () => {
    expect(formatQuickClassifyDate("tomorrow", wednesday)).toBe("2026-11-05");
    expect(formatQuickClassifyDate("tomorrow", new Date(2026, 10, 30, 9, 0))).toBe("2026-12-01");
  });

  it("nextMonday 取严格的下一个周一（周三 → 下周周一）", () => {
    expect(formatQuickClassifyDate("nextMonday", wednesday)).toBe("2026-11-09");
  });

  it("nextMonday 对周日取次日、对周一取 7 天后（不会变成今天）", () => {
    expect(formatQuickClassifyDate("nextMonday", new Date(2026, 10, 8, 9, 0))).toBe("2026-11-09");
    expect(formatQuickClassifyDate("nextMonday", new Date(2026, 10, 2, 9, 0))).toBe("2026-11-09");
  });

  it("不修改传入的 now", () => {
    const now = new Date(2026, 10, 4, 15, 30);
    const snapshot = now.getTime();
    formatQuickClassifyDate("nextMonday", now);
    expect(now.getTime()).toBe(snapshot);
  });
});
