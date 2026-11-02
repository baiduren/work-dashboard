import { describe, expect, it } from "vitest";

import {
  clientKeyFromRequest,
  GLOBAL_FAILURE_WINDOW_MS,
  GLOBAL_MAX_FAILURES,
  LoginRateLimiter,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  MAX_TRACKED_KEYS,
} from "../lib/auth/ratelimit";

// 登录限流：15 分钟窗口内同一来源连续失败 5 次后拒绝，冷却后可再试；
// 另有全局失败阈值与有界容量（docs/02-acceptance.md「认证验收」）。

const T0 = 1_700_000_000_000;

describe("LoginRateLimiter", () => {
  it("窗口常量为 15 分钟 5 次，全局阈值为 10 分钟 100 次", () => {
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(LOGIN_MAX_FAILURES).toBe(5);
    expect(GLOBAL_FAILURE_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(GLOBAL_MAX_FAILURES).toBe(100);
    expect(MAX_TRACKED_KEYS).toBe(10_000);
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

describe("全局限流阈值", () => {
  it("窗口内失败总数达到阈值后全局拒绝，并给出 Retry-After", () => {
    const limiter = new LoginRateLimiter({ globalMaxFailures: 3 });
    limiter.recordFailure("a", T0);
    limiter.recordFailure("b", T0);
    expect(limiter.isGloballyLimited(T0)).toBe(false);
    limiter.recordFailure("c", T0);
    expect(limiter.isGloballyLimited(T0)).toBe(true);
    expect(limiter.globalRetryAfterSeconds(T0)).toBe(10 * 60);
    // 全局触发不影响单键判定本身（组合判断在 attemptLogin）
    expect(limiter.isLimited("d", T0)).toBe(false);
  });

  it("全局窗口过期后自动解除，新失败重新计时", () => {
    const limiter = new LoginRateLimiter({ globalMaxFailures: 1, globalWindowMs: 1000 });
    limiter.recordFailure("a", T0);
    expect(limiter.isGloballyLimited(T0 + 999)).toBe(true);
    expect(limiter.isGloballyLimited(T0 + 1000)).toBe(false);
    expect(limiter.globalRetryAfterSeconds(T0 + 1000)).toBe(0);
    limiter.recordFailure("b", T0 + 1001); // 新窗口重新计数
    expect(limiter.isGloballyLimited(T0 + 1500)).toBe(true);
    expect(limiter.isGloballyLimited(T0 + 2001)).toBe(false);
  });

  it("全局计数不因成功/重置而回退，只随窗口过期清零", () => {
    const limiter = new LoginRateLimiter({ globalMaxFailures: 2 });
    limiter.recordFailure("a", T0);
    limiter.recordFailure("b", T0);
    limiter.reset("a");
    limiter.reset("b");
    expect(limiter.isGloballyLimited(T0)).toBe(true);
  });
});

describe("限流记录有界", () => {
  it("持续写入不同键时记录数不超过上限（先清过期、再淘汰最旧）", () => {
    const limiter = new LoginRateLimiter({ maxKeys: 5 });
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`key-${i}`, T0);
      expect(limiter.size).toBeLessThanOrEqual(5);
    }
  });

  it("达到上限后新键顶替最旧键，未过期的旧键计数保留", () => {
    const limiter = new LoginRateLimiter({ maxKeys: 3 });
    for (const key of ["k1", "k2", "k3"]) {
      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) limiter.recordFailure(key, T0);
    }
    expect(limiter.size).toBe(3);
    limiter.recordFailure("k4", T0); // 满 → 淘汰最早插入的 k1
    expect(limiter.size).toBe(3);
    expect(limiter.isLimited("k1", T0)).toBe(false); // 被淘汰，重新计数
    expect(limiter.isLimited("k2", T0)).toBe(true); // 保留
    expect(limiter.isLimited("k3", T0)).toBe(true); // 保留
  });

  it("满员时优先清理过期项，而不是淘汰未过期的键", () => {
    const limiter = new LoginRateLimiter({ maxKeys: 2, windowMs: 1000, maxFailures: 2 });
    limiter.recordFailure("a", T0);
    limiter.recordFailure("b", T0);
    limiter.recordFailure("c", T0 + 1000); // a、b 已过期 → 清理后容纳 c
    expect(limiter.size).toBe(1);
    expect(limiter.isLimited("a", T0 + 1000)).toBe(false);
    expect(limiter.isLimited("b", T0 + 1000)).toBe(false);
    expect(limiter.isLimited("c", T0 + 1000)).toBe(false); // 仅 1 次失败，但键已被跟踪
    limiter.recordFailure("c", T0 + 1000);
    expect(limiter.isLimited("c", T0 + 1000)).toBe(true);
  });

  it("超长键被截断到固定上限，不因伪造头撑大内存", () => {
    const limiter = new LoginRateLimiter({ maxFailures: 1 });
    const longKey = "a".repeat(500);
    limiter.recordFailure(longKey, T0);
    // 截断后同一前缀映射到同一个键
    expect(limiter.isLimited("a".repeat(128), T0)).toBe(true);
    expect(limiter.isLimited("a".repeat(300), T0)).toBe(true);
  });
});

describe("clientKeyFromRequest", () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it("优先取代理注入的 x-real-ip", () => {
    expect(clientKeyFromRequest(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
  });

  it("其次取 CF-Connecting-IP", () => {
    expect(clientKeyFromRequest(headers({ "cf-connecting-ip": "198.51.100.3" }))).toBe(
      "198.51.100.3",
    );
    expect(
      clientKeyFromRequest(
        headers({ "x-real-ip": "198.51.100.2", "cf-connecting-ip": "198.51.100.3" }),
      ),
    ).toBe("198.51.100.2");
  });

  it("完全不读取客户端可伪造的 x-forwarded-for", () => {
    expect(clientKeyFromRequest(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "unknown",
    );
  });

  it("伪造 X-Forwarded-For 轮换时，限流键不再变化", () => {
    const first = clientKeyFromRequest(headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }));
    const second = clientKeyFromRequest(headers({ "x-forwarded-for": "5.6.7.8, 9.10.11.12" }));
    const third = clientKeyFromRequest(headers({ "x-forwarded-for": "172.16.0.1" }));
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBe("unknown");
  });

  it("x-real-ip 存在时忽略 x-forwarded-for", () => {
    expect(
      clientKeyFromRequest(
        headers({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
      ),
    ).toBe("198.51.100.2");
  });

  it("来源头缺失或为空白时退化为 unknown", () => {
    expect(clientKeyFromRequest(headers({}))).toBe("unknown");
    expect(clientKeyFromRequest(headers({ "x-real-ip": "   " }))).toBe("unknown");
    expect(clientKeyFromRequest(headers({ "x-real-ip": "  198.51.100.2  " }))).toBe("198.51.100.2");
  });
});
