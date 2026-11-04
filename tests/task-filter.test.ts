// 任务筛选参数解析的单元测试（Issue #51）：
// 覆盖 q 的空串 / 纯空白语义、页面侧非法参数容错与筛选生效判断。

import { describe, expect, it } from "vitest";

import {
  hasActiveFilters,
  parseFilterPriorityLoose,
  parseFilterQuery,
  parseFilterTagIdLoose,
  readPageTaskFilters,
} from "../lib/domain/task-filter";

describe("parseFilterQuery", () => {
  it("裁剪首尾空白并保留原样关键词", () => {
    expect(parseFilterQuery("  周报  ")).toBe("周报");
    expect(parseFilterQuery("Weekly Report")).toBe("Weekly Report");
  });

  it("空串 / 纯空白 / 缺失视为未提供", () => {
    expect(parseFilterQuery("")).toBeUndefined();
    expect(parseFilterQuery("   ")).toBeUndefined();
    expect(parseFilterQuery(undefined)).toBeUndefined();
  });

  it("数组取第一个值（页面 searchParams 可能重复）", () => {
    expect(parseFilterQuery(["周报", "月报"])).toBe("周报");
  });
});

describe("parseFilterPriorityLoose / parseFilterTagIdLoose", () => {
  it("priority 只接受 low | medium | high", () => {
    expect(parseFilterPriorityLoose("high")).toBe("high");
    expect(parseFilterPriorityLoose("urgent")).toBeUndefined();
    expect(parseFilterPriorityLoose("")).toBeUndefined();
    expect(parseFilterPriorityLoose(undefined)).toBeUndefined();
  });

  it("tagId 裁剪空白，空串视为未提供", () => {
    expect(parseFilterTagIdLoose(" tag-1 ")).toBe("tag-1");
    expect(parseFilterTagIdLoose("   ")).toBeUndefined();
    expect(parseFilterTagIdLoose(undefined)).toBeUndefined();
  });
});

describe("readPageTaskFilters / hasActiveFilters", () => {
  it("读取组合筛选，并判断是否生效", () => {
    expect(readPageTaskFilters({ q: " 周报 ", priority: "high", tagId: "tag-1" })).toEqual({
      q: "周报",
      priority: "high",
      tagId: "tag-1",
    });
    expect(hasActiveFilters(readPageTaskFilters({ q: "   ", priority: "", tagId: "" }))).toBe(false);
    expect(hasActiveFilters(readPageTaskFilters({ priority: "urgent" }))).toBe(false);
    expect(hasActiveFilters(readPageTaskFilters({ q: "周报" }))).toBe(true);
  });
});
