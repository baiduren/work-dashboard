import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_COLOR,
  normalizeProjectPatch,
  parseProjectColor,
  parseProjectName,
  PROJECT_COLORS,
  PROJECT_NAME_MAX_LENGTH,
} from "../lib/domain/project";
import { TaskValidationError } from "../lib/domain/task";

// 项目领域逻辑单测（Issue #27「范围 1」）：name / color 取值校验、更新补丁归一化。
// 与任务一致，非法输入统一抛 TaskValidationError（field 指出出错字段），调用方映射为 400。

function expectValidationError(fn: () => unknown, field?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error, "应抛出 TaskValidationError").toBeInstanceOf(TaskValidationError);
    const validationError = error as TaskValidationError;
    expect(validationError.name).toBe("TaskValidationError");
    if (field !== undefined) expect(validationError.field).toBe(field);
    return;
  }
  throw new Error("期望抛出 TaskValidationError，但没有抛出");
}

describe("parseProjectName", () => {
  it("接受非空字符串并裁剪首尾空白", () => {
    expect(parseProjectName("官网改版")).toBe("官网改版");
    expect(parseProjectName("  工作汇报  ")).toBe("工作汇报");
    expect(parseProjectName("a")).toBe("a");
  });

  it("60 字符是上限（恰好 60 通过，61 拒绝）", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(60);
    const atLimit = "x".repeat(60);
    expect(parseProjectName(atLimit)).toBe(atLimit);
    expect(() => parseProjectName(`${atLimit}x`)).toThrow();
  });

  it("拒绝空 / 纯空白 / 非字符串", () => {
    for (const invalid of [undefined, null, "", "   ", 42, {}, []]) {
      expectValidationError(() => parseProjectName(invalid), "name");
    }
  });
});

describe("parseProjectColor", () => {
  it("接受 #RRGGBB 十六进制（大小写均可）", () => {
    expect(parseProjectColor("#ef4444")).toBe("#ef4444");
    expect(parseProjectColor("#3B82F6")).toBe("#3B82F6");
    expect(parseProjectColor("  #22c55e  ")).toBe("#22c55e");
    expect(parseProjectColor("#000000")).toBe("#000000");
    expect(parseProjectColor("#FFFFFF")).toBe("#FFFFFF");
  });

  it("undefined / null / 空串 / 纯空白视为 null（清空颜色）", () => {
    expect(parseProjectColor(undefined)).toBeNull();
    expect(parseProjectColor(null)).toBeNull();
    expect(parseProjectColor("")).toBeNull();
    expect(parseProjectColor("   ")).toBeNull();
  });

  it("拒绝非法颜色格式与类型", () => {
    for (const invalid of [
      "red",
      "ef4444",
      "#ef444",
      "#ef44444",
      "#ggg222",
      "#ef 444",
      "##ef4444",
      "ef4444;--",
      42,
      true,
      {},
      [],
    ]) {
      expectValidationError(() => parseProjectColor(invalid), "color");
    }
  });
});

describe("normalizeProjectPatch", () => {
  it("空对象 / 未提供字段 → 空补丁（不改任何字段）", () => {
    expect(normalizeProjectPatch({})).toEqual({});
  });

  it("只挑选 name / color / archived，其余字段一律忽略（Issue #43 起 archived 参与补丁）", () => {
    expect(
      normalizeProjectPatch({ name: " 新项目 ", color: "#ff0000", archived: true, id: "x" }),
    ).toEqual({ name: "新项目", color: "#ff0000", archived: true });
    expect(normalizeProjectPatch({ foo: "bar" })).toEqual({});
  });

  it("archived 必须是布尔值：true / false 通过，其余类型抛 TaskValidationError（field=archived）", () => {
    expect(normalizeProjectPatch({ archived: true })).toEqual({ archived: true });
    expect(normalizeProjectPatch({ archived: false })).toEqual({ archived: false });
    for (const bad of ["true", 1, null]) {
      expectValidationError(() => normalizeProjectPatch({ archived: bad }), "archived");
    }
  });

  it("显式 color=null 表示清空；未提供的字段不出现在结果里", () => {
    expect(normalizeProjectPatch({ color: null })).toEqual({ color: null });
    expect(normalizeProjectPatch({ name: "官网改版" })).toEqual({ name: "官网改版" });
  });

  it("字段非法时抛 TaskValidationError（field 指出出错字段）", () => {
    expectValidationError(() => normalizeProjectPatch({ name: "   " }), "name");
    expectValidationError(() => normalizeProjectPatch({ name: "x".repeat(61) }), "name");
    expectValidationError(() => normalizeProjectPatch({ color: "red" }), "color");
    expectValidationError(() => normalizeProjectPatch({ color: 42 }), "color");
  });

  it("输入不是对象时抛 TaskValidationError", () => {
    for (const invalid of [undefined, null, "name", 42, [], true]) {
      expectValidationError(() => normalizeProjectPatch(invalid), "patch");
    }
  });
});

describe("固定 6 色候选（新建表单用）", () => {
  it("6 个候选色均为合法 #RRGGBB，默认色在候选内", () => {
    expect(PROJECT_COLORS).toHaveLength(6);
    for (const color of PROJECT_COLORS) {
      expect(parseProjectColor(color)).toBe(color);
    }
    expect(PROJECT_COLORS).toContain(DEFAULT_PROJECT_COLOR);
  });
});
