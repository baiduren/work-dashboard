import { describe, expect, it } from "vitest";

import { constantTimeEqual, verifyCredentials } from "../lib/auth/password";

// 恒定时间密码比较（docs/adr/0004-authentication.md「防护」）。

const CONFIG = {
  username: "admin",
  password: "s3cret-パスワード",
  secret: "unit-test-secret-0123456789abcdef0123456789abcdef",
};

describe("constantTimeEqual", () => {
  it("相同字符串返回 true", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("不同内容返回 false", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "")).toBe(false);
  });

  it("长度不同的输入不抛异常且返回 false", () => {
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("长字符串测试", "短")).toBe(false);
  });

  it("Unicode 内容可正确比较", () => {
    expect(constantTimeEqual("密码✓", "密码✓")).toBe(true);
    expect(constantTimeEqual("密码✓", "密码✗")).toBe(false);
  });
});

describe("verifyCredentials", () => {
  it("账号与密码都正确时通过", () => {
    expect(
      verifyCredentials({ username: "admin", password: "s3cret-パスワード" }, CONFIG),
    ).toBe(true);
  });

  it("密码错误时拒绝", () => {
    expect(verifyCredentials({ username: "admin", password: "wrong" }, CONFIG)).toBe(false);
  });

  it("账号错误时拒绝", () => {
    expect(
      verifyCredentials({ username: "root", password: "s3cret-パスワード" }, CONFIG),
    ).toBe(false);
  });

  it("账号与密码都错误时拒绝", () => {
    expect(verifyCredentials({ username: "root", password: "wrong" }, CONFIG)).toBe(false);
  });

  it("密码区分大小写与前后空格", () => {
    expect(verifyCredentials({ username: "admin", password: "S3CRET-パスワード" }, CONFIG)).toBe(
      false,
    );
    expect(verifyCredentials({ username: "admin", password: " s3cret-パスワード" }, CONFIG)).toBe(
      false,
    );
  });
});
