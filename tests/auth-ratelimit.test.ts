import { describe, expect, it } from "vitest";

import {
  clientKeyFromRequest,
  LoginRateLimiter,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
} from "../lib/auth/ratelimit";

// 登录限流：15 分钟窗口内同一来源连续失败 5 次后拒绝，冷却后可再试
//（docs/02-acceptance.md「认证验收」）。

const T0 = 1_700_000_000_000;

describe("LoginRateLimiter", () => {
  it("窗口常量为 15 分钟 5 次", () => {
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(LOGIN_MAX_FAILURES).toBe(5);
  });

  it("失败不足阈值时不限流，达到 5 次后限流", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      limiter.recordFailure("1.1.1.1", T0);
      expect(limiter.isLimited("1.1.1.1", T0)).toBe(false);
    }
    limiter.recordFailure("1.1.1.1", T0);
    expect(limiter.isLimited("1.1.1.1", T0)).toBe(true);
  });

  it("限流时给出冷却剩余秒数（Retry-After）", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure("1.1.1.1", T0);
    expect(limiter.retryAfterSeconds("1.1.1.1", T0 + 60_000)).toBe(14 * 60);
    expect(limiter.retryAfterSeconds("1.1.1.1", T0)).toBe(15 * 60);
  });

  it("窗口过期后自动解除，可再次尝试", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure("1.1.1.1", T0);
    expect(limiter.isLimited("1.1.1.1", T0 + LOGIN_WINDOW_MS - 1)).toBe(true);
    expect(limiter.isLimited("1.1.1.1", T0 + LOGIN_WINDOW_MS)).toBe(false);
  });

  it("登录成功重置失败计数（连续失败语义）", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure("1.1.1.1", T0);
    limiter.reset("1.1.1.1");
    expect(limiter.isLimited("1.1.1.1", T0)).toBe(false);
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.recordFailure("1.1.1.1", T0);
    expect(limiter.isLimited("1.1.1.1", T0)).toBe(false);
  });

  it("不同来源互不影响", () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure("1.1.1.1", T0);
    expect(limiter.isLimited("1.1.1.1", T0)).toBe(true);
    expect(limiter.isLimited("2.2.2.2", T0)).toBe(false);
  });

  it("窗口内首次失败决定窗口起点，跨窗口的失败重新计数", () => {
    const limiter = new LoginRateLimiter({ windowMs: 1000, maxFailures: 2 });
    limiter.recordFailure("k", T0);
    limiter.recordFailure("k", T0 + 900); // 仍在窗口内 → 2 次 → 限流
    expect(limiter.isLimited("k", T0 + 950)).toBe(true);
    expect(limiter.isLimited("k", T0 + 1000)).toBe(false); // 冷却结束
    limiter.recordFailure("k", T0 + 1001); // 新窗口重新计数
    expect(limiter.isLimited("k", T0 + 1500)).toBe(false);
  });
});

describe("clientKeyFromRequest", () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it("优先取 x-forwarded-for 的第一段", () => {
    expect(
      clientKeyFromRequest(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    ).toBe("203.0.113.7");
  });

  it("退回 x-real-ip，再退回 unknown", () => {
    expect(clientKeyFromRequest(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientKeyFromRequest(headers({}))).toBe("unknown");
  });
});
