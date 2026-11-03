// 今日视图客户端交互纯逻辑的单测（Issue #25）：
// 快速添加 payload 构造（标题裁剪/空白忽略/默认值）、本地日期格式化、
// 日期输入的清空语义。取值规则来自 lib/domain/task.ts，这里验证其在 UI 层的接线。

import { describe, expect, it } from "vitest";

import {
  buildQuickAddPayload,
  dueDateInputToPatch,
  formatLocalDate,
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
