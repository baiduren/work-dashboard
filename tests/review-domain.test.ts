import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEEK_STARTS_ON,
  parseWeekDate,
  shiftWeek,
  startOfWeek,
  weekRange,
} from "../lib/domain/review";
import { TaskValidationError } from "../lib/domain/task";

// 周回顾领域逻辑单测（Issue #44）：纯函数、日期边界可注入。
// 重点覆盖周边界归属（docs/02-acceptance.md「周回顾验收」）：
// 周一 00:00:00 属于本周；周日 23:59:59.999 属于本周；下周一 00:00:00 属于下周；
// 跨月 / 跨年周（2026-12-29 那周）边界正确。全部按本地时区断言（与生产一致）。

/** 周一 2026-11-02 12:00（本地时区）。 */
const NOW = new Date(2026, 10, 2, 12, 0, 0, 0);

describe("startOfWeek", () => {
  it("本周内各时间点都归到同一周一 00:00", () => {
    const monday = new Date(2026, 10, 2, 0, 0, 0, 0);
    // 周一 00:00:00 本身属于本周
    expect(startOfWeek(new Date(2026, 10, 2, 0, 0, 0, 0))).toEqual(monday);
    // 周中（周三 18:30）
    expect(startOfWeek(new Date(2026, 10, 4, 18, 30, 0))).toEqual(monday);
    // 周日最后一毫秒仍属于本周
    expect(startOfWeek(new Date(2026, 10, 8, 23, 59, 59, 999))).toEqual(monday);
    // 下周一 00:00:00 起属于下周
    expect(startOfWeek(new Date(2026, 10, 9, 0, 0, 0, 0))).toEqual(new Date(2026, 10, 9, 0, 0, 0, 0));
  });

  it("参数化周起始日：weekStartsOn = 0（周日）时周日归到当天", () => {
    // 2026-11-08 是周日：缺省（周一）归到 11-02，按周日起始归到 11-08
    expect(startOfWeek(new Date(2026, 10, 8, 15, 0, 0))).toEqual(new Date(2026, 10, 2));
    expect(startOfWeek(new Date(2026, 10, 8, 15, 0, 0), 0)).toEqual(new Date(2026, 10, 8));
    // 周六（11-07）在周日起始制下归到 11-01 那周
    expect(startOfWeek(new Date(2026, 10, 7, 9, 0, 0), 0)).toEqual(new Date(2026, 10, 1));
  });

  it("不修改传入的 now（返回新 Date）", () => {
    const now = new Date(2026, 10, 4, 18, 30, 0);
    const snapshot = now.getTime();
    startOfWeek(now);
    expect(now.getTime()).toBe(snapshot);
  });

  it("缺省周起始日为周一", () => {
    expect(DEFAULT_WEEK_STARTS_ON).toBe(1);
    expect(startOfWeek(new Date(2026, 10, 7, 9, 0, 0))).toEqual(new Date(2026, 10, 2));
  });

  it("拒绝非法 weekStartsOn", () => {
    for (const bad of [-1, 7, 1.5] as never[]) {
      expect(() => startOfWeek(NOW, bad)).toThrow(TaskValidationError);
    }
  });
});

describe("weekRange", () => {
  it("from = 周一 00:00，to = 下周一 00:00，恰好 7 天", () => {
    const range = weekRange(NOW);
    expect(range.from).toEqual(new Date(2026, 10, 2, 0, 0, 0, 0));
    expect(range.to).toEqual(new Date(2026, 10, 9, 0, 0, 0, 0));
    expect(range.to.getTime() - range.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("边界归属（含头不含尾）：周一 00:00 在内，周日 23:59:59.999 在内，下周一 00:00:00 不在内", () => {
    const { from, to } = weekRange(NOW);
    expect(new Date(2026, 10, 2, 0, 0, 0, 0).getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect(new Date(2026, 10, 2, 0, 0, 0, 0).getTime()).toBeLessThan(to.getTime());
    expect(new Date(2026, 10, 8, 23, 59, 59, 999).getTime()).toBeLessThan(to.getTime());
    expect(new Date(2026, 10, 9, 0, 0, 0, 0).getTime()).toBeGreaterThanOrEqual(to.getTime());
  });

  it("跨月 / 跨年周（2026-12-29 那周）：2026-12-28 ~ 2027-01-04", () => {
    // 2026-12-29 是周二，该周从 2026-12-28（周一）到 2027-01-03（周日）
    const range = weekRange(new Date(2026, 11, 29, 10, 0, 0));
    expect(range.from).toEqual(new Date(2026, 11, 28, 0, 0, 0, 0));
    expect(range.to).toEqual(new Date(2027, 0, 4, 0, 0, 0, 0));
  });
});

describe("shiftWeek", () => {
  it("按整数周平移：上一周 / 下一周", () => {
    const monday = new Date(2026, 10, 2, 0, 0, 0, 0);
    expect(shiftWeek(monday, 1)).toEqual(new Date(2026, 10, 9));
    expect(shiftWeek(monday, -1)).toEqual(new Date(2026, 9, 26));
    expect(shiftWeek(monday, 0)).toEqual(monday);
  });

  it("跨月 / 跨年平移边界正确", () => {
    expect(shiftWeek(new Date(2026, 11, 28), 1)).toEqual(new Date(2027, 0, 4));
    expect(shiftWeek(new Date(2027, 0, 4), -1)).toEqual(new Date(2026, 11, 28));
    expect(shiftWeek(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 25));
  });

  it("不修改传入的 from（返回新 Date）", () => {
    const from = new Date(2026, 10, 2);
    const snapshot = from.getTime();
    shiftWeek(from, 1);
    expect(from.getTime()).toBe(snapshot);
  });

  it("拒绝非整数 weeks", () => {
    expect(() => shiftWeek(new Date(2026, 10, 2), 0.5)).toThrow(TaskValidationError);
  });
});

describe("parseWeekDate", () => {
  it("合法 YYYY-MM-DD 返回该日本地 00:00", () => {
    expect(parseWeekDate("2026-11-02")).toEqual(new Date(2026, 10, 2, 0, 0, 0, 0));
  });

  it("缺失 / 非法 / 不存在的日期一律返回 null（调用方回退本周）", () => {
    expect(parseWeekDate(undefined)).toBeNull();
    expect(parseWeekDate("")).toBeNull();
    expect(parseWeekDate("abc")).toBeNull();
    expect(parseWeekDate("2026-2-3")).toBeNull(); // 格式必须补零
    expect(parseWeekDate("2026-13-01")).toBeNull(); // 月份越界
    expect(parseWeekDate("2026-02-30")).toBeNull(); // 不存在的日期（Date 会静默滚动，必须拒绝）
    expect(parseWeekDate("2026-11-02T10:00:00")).toBeNull(); // 只接受纯日期
    expect(parseWeekDate(42 as never)).toBeNull();
    expect(parseWeekDate(null as never)).toBeNull();
  });
});
