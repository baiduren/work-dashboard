import { describe, expect, it } from "vitest";

import { parseHexColor } from "../lib/domain/color";
import { parseProjectColor } from "../lib/domain/project";
import {
  parseTagColor,
  parseTagIds,
  parseTagName,
  TAG_NAME_MAX_LENGTH,
  TagValidationError,
} from "../lib/domain/tag";
import { TaskValidationError } from "../lib/domain/task";

// 标签领域逻辑单测（Issue #39「范围 1」）：parseTagName / parseTagColor / parseTagIds 边界
// （空、超长、非法色值），与错误类型语义（TaskValidationError / TagValidationError 可被
// toErrorResponse 识别映射 400）。

describe("parseTagName", () => {
  it("接受合法名称并裁剪首尾空白", () => {
    expect(parseTagName("紧急")).toBe("紧急");
    expect(parseTagName("  周会  ")).toBe("周会");
    expect(parseTagName("a".repeat(TAG_NAME_MAX_LENGTH))).toBe("a".repeat(TAG_NAME_MAX_LENGTH));
  });

  it("拒绝非字符串", () => {
    for (const value of [undefined, null, 42, true, ["紧急"], { name: "紧急" }]) {
      expect(() => parseTagName(value)).toBeInstanceOf(Object);
      try {
        parseTagName(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect((error as TaskValidationError).field).toBe("name");
        expect((error as TaskValidationError).message).toContain("name 必须是字符串");
      }
    }
  });

  it("拒绝空与纯空白", () => {
    for (const value of ["", "   ", "\t\n"]) {
      try {
        parseTagName(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect((error as TaskValidationError).field).toBe("name");
        expect((error as TaskValidationError).message).toBe("name 不能为空");
      }
    }
  });

  it("拒绝超过 24 字符（按 trim 后计）", () => {
    const long = "标".repeat(TAG_NAME_MAX_LENGTH + 1);
    try {
      parseTagName(long);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TaskValidationError);
      expect((error as TaskValidationError).field).toBe("name");
      expect((error as TaskValidationError).message).toContain("24");
    }
    // trim 前超长、trim 后恰好 24：接受
    const padded = `  ${"a".repeat(TAG_NAME_MAX_LENGTH)}  `;
    expect(parseTagName(padded)).toBe("a".repeat(TAG_NAME_MAX_LENGTH));
  });
});

describe("parseTagColor", () => {
  it("接受 #RRGGBB 与空值（null / undefined / 空串 → null）", () => {
    expect(parseTagColor("#ef4444")).toBe("#ef4444");
    expect(parseTagColor("#EF4444")).toBe("#EF4444");
    expect(parseTagColor(" #3b82f6 ")).toBe("#3b82f6");
    expect(parseTagColor(null)).toBeNull();
    expect(parseTagColor(undefined)).toBeNull();
    expect(parseTagColor("")).toBeNull();
    expect(parseTagColor("   ")).toBeNull();
  });

  it("拒绝非法色值与非法类型（field=color）", () => {
    for (const value of ["red", "#12345", "#1234567", "#12345g", "ef4444", 42, ["#ef4444"]]) {
      try {
        parseTagColor(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect((error as TaskValidationError).field).toBe("color");
      }
    }
  });

  it("与项目颜色共用同一规则（lib/domain/color.ts）", () => {
    // 同一输入在 parseProjectColor / parseTagColor / parseHexColor 下结果一致
    //（成功值相同；抛错时错误类型与文案相同）。
    const viaHelpers = (fn: (v: unknown) => unknown, value: unknown): string => {
      try {
        return String(fn(value));
      } catch (error) {
        return String(error);
      }
    };
    for (const value of ["#ef4444", "", null, undefined, "red", 42]) {
      const viaProject = viaHelpers(parseProjectColor, value);
      const viaTag = viaHelpers(parseTagColor, value);
      const viaHex = viaHelpers((v) => parseHexColor(v, "color"), value);
      expect(viaTag).toBe(viaProject);
      expect(viaTag).toBe(viaHex);
    }
  });
});

describe("parseTagIds", () => {
  it("接受字符串数组并逐项裁剪，保持顺序", () => {
    expect(parseTagIds(["a", " b "])).toEqual(["a", "b"]);
    expect(parseTagIds([])).toEqual([]);
  });

  it("拒绝非数组输入", () => {
    for (const value of [undefined, null, "tag-1", 42, { 0: "tag-1" }]) {
      try {
        parseTagIds(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect((error as TaskValidationError).field).toBe("tagIds");
        expect((error as TaskValidationError).message).toContain("tagIds 必须是字符串数组");
      }
    }
  });

  it("拒绝含空串 / 纯空白 / 非字符串项", () => {
    for (const value of [[""], ["  "], ["ok", ""], ["ok", 42], ["ok", null]]) {
      try {
        parseTagIds(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TaskValidationError);
        expect((error as TaskValidationError).field).toBe("tagIds");
        expect((error as TaskValidationError).message).toContain("tagIds[");
      }
    }
  });
});

describe("TagValidationError", () => {
  it("是 TaskValidationError 子类（复用 400 映射）并携带 field", () => {
    const error = new TagValidationError("标签名已存在", "name");
    expect(error).toBeInstanceOf(TaskValidationError);
    expect(error.name).toBe("TagValidationError");
    expect(error.message).toBe("标签名已存在");
    expect(error.field).toBe("name");
  });
});
