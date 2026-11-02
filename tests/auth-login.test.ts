import { describe, expect, it } from "vitest";

import { attemptLogin } from "../lib/auth/login";
import {
  clientKeyFromRequest,
  LOGIN_MAX_FAILURES,
  LoginRateLimiter,
} from "../lib/auth/ratelimit";
import { deriveSessionKey, verifySessionToken } from "../lib/auth/session";

// 登录成功 / 失败 / 限流的整体流程（docs/02-acceptance.md「认证验收」）。

const CONFIG = {
  username: "admin",
  password: "correct-horse",
  secret: "unit-test-secret-0123456789abcdef0123456789abcdef",
};

// 以当前时间为基准（成功用例签发的令牌需通过真实时钟的过期校验）；
// 其余时间差都在 T0 基础上相对推算。
const T0 = Date.now();
const CLIENT = "203.0.113.7";

function freshLimiter(): LoginRateLimiter {
  return new LoginRateLimiter();
}

async function failNTimes(limiter: LoginRateLimiter, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await attemptLogin({
      username: "admin",
      password: "wrong",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0,
    });
  }
}

describe("attemptLogin", () => {
  it("正确凭据登录成功，签发可校验的 7 天会话令牌", async () => {
    const result = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter: freshLimiter(),
      now: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const key = await deriveSessionKey(CONFIG.secret, CONFIG.password);
    const session = await verifySessionToken(result.token, key);
    expect(session).not.toBeNull();
    if (!session) return;
    expect(session.sub).toBe("admin");
    expect(session.exp - session.iat).toBe(7 * 24 * 60 * 60);
  });

  it("错误密码登录失败，不下发令牌", async () => {
    const result = await attemptLogin({
      username: "admin",
      password: "wrong",
      clientKey: CLIENT,
      config: CONFIG,
      limiter: freshLimiter(),
      now: T0,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("账号错误登录失败", async () => {
    const result = await attemptLogin({
      username: "root",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter: freshLimiter(),
      now: T0,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("非字符串输入按失败处理，不抛异常", async () => {
    for (const username of [undefined, null, 1, {}]) {
      const result = await attemptLogin({
        username,
        password: "correct-horse",
        clientKey: CLIENT,
        config: CONFIG,
        limiter: freshLimiter(),
        now: T0,
      });
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("同一来源连续失败 5 次后被限流，正确凭据也拒绝", async () => {
    const limiter = freshLimiter();
    await failNTimes(limiter, 5);
    const limited = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(limited).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 15 * 60 });
  });

  it("成功登录重置失败计数：4 次失败 + 成功 + 4 次失败仍可登录", async () => {
    const limiter = freshLimiter();
    await failNTimes(limiter, 4);
    const first = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(first.ok).toBe(true);
    await failNTimes(limiter, 4);
    const second = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(second.ok).toBe(true);
  });

  it("冷却结束后可再试", async () => {
    const limiter = new LoginRateLimiter();
    await failNTimes(limiter, 5);
    const during = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0 + 15 * 60 * 1000 - 1,
    });
    expect(during).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 1 });
    const after = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0 + 15 * 60 * 1000,
    });
    expect(after.ok).toBe(true);
  });

  it("账号维度未达阈值时，其他来源仍可正常登录", async () => {
    const limiter = freshLimiter();
    await failNTimes(limiter, LOGIN_MAX_FAILURES - 1); // admin 从 CLIENT 失败 4 次
    const other = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: "198.51.100.9",
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(other.ok).toBe(true);
  });

  it("换 IP 撞同一账号：账号维度达到阈值后，换来源的正确凭据也被拒", async () => {
    const limiter = freshLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const result = await attemptLogin({
        username: "admin",
        password: "wrong",
        clientKey: `203.0.113.${i}`,
        config: CONFIG,
        limiter,
        now: T0,
      });
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
    const blocked = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: "198.51.100.9",
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(blocked).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 15 * 60 });
  });

  it("同一来源换账号撞库：来源维度达到阈值后，换账号也被拒", async () => {
    const limiter = freshLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const result = await attemptLogin({
        username: `user-${i}`,
        password: "wrong",
        clientKey: CLIENT,
        config: CONFIG,
        limiter,
        now: T0,
      });
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
    const blocked = await attemptLogin({
      username: "another-user",
      password: "correct-horse",
      clientKey: CLIENT,
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(blocked).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 15 * 60 });
  });

  it("伪造 X-Forwarded-For 轮换不产生新的限流键（缺省 unknown 照常累计）", async () => {
    const limiter = freshLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const result = await attemptLogin({
        username: `u${i}`, // 每次换账号，只有来源维度会累计
        password: "wrong",
        clientKey: clientKeyFromRequest(
          new Headers({ "x-forwarded-for": `10.0.0.${i}, 192.168.1.1` }),
        ),
        config: CONFIG,
        limiter,
        now: T0,
      });
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
    const limited = await attemptLogin({
      username: "u5",
      password: "wrong",
      clientKey: clientKeyFromRequest(new Headers({ "x-forwarded-for": "172.16.0.1" })),
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(limited).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 15 * 60 });
  });

  it("全局失败阈值触发后，正确凭据也被拒绝（Retry-After 取全局窗口）", async () => {
    const limiter = new LoginRateLimiter({ globalMaxFailures: 2 });
    for (let i = 0; i < 2; i++) {
      await attemptLogin({
        username: `u${i}`,
        password: "wrong",
        clientKey: `203.0.113.${i}`,
        config: CONFIG,
        limiter,
        now: T0,
      });
    }
    const blocked = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: "198.51.100.1",
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(blocked).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 10 * 60 });
  });

  it("成功登录同时重置来源与账号两个维度的失败计数", async () => {
    const limiter = freshLimiter();
    // 同一账号在 4 个不同来源各失败 1 次：账号维度 4 次、各来源各 1 次
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      await attemptLogin({
        username: "admin",
        password: "wrong",
        clientKey: `203.0.113.${i}`,
        config: CONFIG,
        limiter,
        now: T0,
      });
    }
    const first = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: "203.0.113.9",
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(first.ok).toBe(true);
    // 两个维度都已重置，再积累 4 次失败仍不会限流
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      await attemptLogin({
        username: "admin",
        password: "wrong",
        clientKey: `203.0.113.${i}`,
        config: CONFIG,
        limiter,
        now: T0,
      });
    }
    const second = await attemptLogin({
      username: "admin",
      password: "correct-horse",
      clientKey: "203.0.113.9",
      config: CONFIG,
      limiter,
      now: T0,
    });
    expect(second.ok).toBe(true);
  });

  it("非字符串账号不产生账号维度限流键，仅按来源计数", async () => {
    const limiter = freshLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      await attemptLogin({
        username: { attacker: true },
        password: "wrong",
        clientKey: CLIENT,
        config: CONFIG,
        limiter,
        now: T0,
      });
    }
    expect(limiter.isLimited(CLIENT, T0)).toBe(true);
    // 账号维度键不存在：isLimited("user:...") 为 false
    expect(limiter.isLimited("user:admin", T0)).toBe(false);
  });
});
