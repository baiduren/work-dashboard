import { describe, expect, it } from "vitest";

import { attemptLogin } from "../lib/auth/login";
import { LoginRateLimiter } from "../lib/auth/ratelimit";
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
    expect(limited).toEqual({ ok: false, reason: "limited" });
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
    expect(during).toEqual({ ok: false, reason: "limited" });
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

  it("不同来源的失败互不牵连", async () => {
    const limiter = freshLimiter();
    await failNTimes(limiter, 5);
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
});
