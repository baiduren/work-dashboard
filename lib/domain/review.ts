// 周回顾领域逻辑（Issue #44；docs/00-product-brief.md「核心场景 5 回顾」：按周查看完成情况）：
// 纯函数、可单测、不依赖数据库与框架；日期边界一律按运行环境本地时区，
// 当前时间由调用方注入（与 lib/domain/task.ts 的 startOfDay / endOfDay 同风格）。
// 周起始日参数化便于测试，缺省周一（本工单不改产品缺省值）。

import { startOfDay, TaskValidationError } from "@/lib/domain/task";

/** 周起始日：0 = 周日 … 6 = 周六；缺省 1 = 周一。 */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 周起始日缺省值：周一（docs/02-acceptance.md「周回顾验收」固定不改）。 */
export const DEFAULT_WEEK_STARTS_ON: WeekStartsOn = 1;

/** 一周区间：from = 周起始日 00:00:00.000，to = 下个周起始日 00:00:00.000（含头不含尾）。 */
export interface WeekRange {
  from: Date;
  to: Date;
}

/** 校验周起始日取值：0..6 的整数，非法抛出 TaskValidationError。 */
function parseWeekStartsOn(weekStartsOn: WeekStartsOn): WeekStartsOn {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new TaskValidationError(
      `weekStartsOn 必须是 0..6 的整数（0 = 周日），收到：${String(weekStartsOn)}`,
      "weekStartsOn",
    );
  }
  return weekStartsOn;
}

/**
 * 本周起点：包含 now 的那一周的周起始日 00:00:00.000（本地时区）。
 * 边界归属：周起始日当天 00:00:00 起属于本周，直到下一个周起始日 00:00:00（不含）。
 */
export function startOfWeek(now: Date, weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): Date {
  const start = parseWeekStartsOn(weekStartsOn);
  const offset = (now.getDay() - start + 7) % 7;
  const result = startOfDay(now);
  result.setDate(result.getDate() - offset);
  return result;
}

/**
 * 一周区间：`{ from, to }`，from = 本周周起始日 00:00，to = 下周周起始日 00:00
 * （含头不含尾，与 lib/db listCompletedBetween 的半开区间查询对齐）。
 */
export function weekRange(now: Date, weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): WeekRange {
  const from = startOfWeek(now, weekStartsOn);
  return { from, to: shiftWeek(from, 1) };
}

/**
 * 按整数周平移：weeks 为负数向前（上一周），正数向后（下一周）。
 * 用日期字段进位（setDate）而不是毫秒累加，跨月 / 跨年 / 夏令时下边界正确。
 * weeks 非整数时抛出 TaskValidationError。
 */
export function shiftWeek(from: Date, weeks: number): Date {
  if (!Number.isInteger(weeks)) {
    throw new TaskValidationError(`weeks 必须是整数，收到：${String(weeks)}`, "weeks");
  }
  const shifted = new Date(from);
  shifted.setDate(shifted.getDate() + weeks * 7);
  return shifted;
}

/**
 * 解析周切换查询参数 `?week=YYYY-MM-DD`：合法时返回该日 00:00:00.000（本地时区），
 * 缺失 / 格式不对 / 不存在的日期（如 2026-02-30）一律返回 null，由调用方回退本周。
 * 严格按 YYYY-MM-DD 解析并确认字段无进位，避免 Date 构造的静默滚动。
 */
export function parseWeekDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}
