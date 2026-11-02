// 密码比较：恒定时间算法（docs/adr/0004-authentication.md）。
// 仅在 Node 运行时（route handlers）使用，middleware 不得导入本文件
// （Edge 运行时没有 node:crypto）。

import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthConfig } from "./config";

/**
 * 恒定时间字符串比较：先对两边做 SHA-256 摘要，再 timingSafeEqual。
 * 摘要长度固定，规避 timingSafeEqual 对不等长输入抛错的问题；
 * 单向摘要保证摘要结果不泄露原文。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** 校验账号与密码是否与部署配置一致（先分别比较再合并，避免短路造成的时间差）。 */
export function verifyCredentials(
  input: { username: string; password: string },
  expected: AuthConfig,
): boolean {
  const usernameMatches = constantTimeEqual(input.username, expected.username);
  const passwordMatches = constantTimeEqual(input.password, expected.password);
  return usernameMatches && passwordMatches;
}
