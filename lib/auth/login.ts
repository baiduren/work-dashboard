// 登录流程编排：限流检查 → 恒定时间凭据校验 → 签发会话令牌。
// 纯逻辑、可单测；route handler 只负责 HTTP 细节（docs/01-architecture.md「模块边界」）。
//
// 限流键组合（docs/01-architecture.md「认证与访问控制」）：
// - 来源键（clientKey）：只信任代理注入的地址，见 clientKeyFromRequest；
// - 账号键（user:<username>）：失败同时计入两个维度——只换 IP 或只换账号的轮换
//   都绕不过已达阈值的另一个维度；
// - 另有全局失败阈值（isGloballyLimited），防分布式撞库；
// - 登录成功同时重置该次尝试的两个维度；全局计数不因成功而回退。

import type { AuthConfig } from "./config";
import { verifyCredentials } from "./password";
import { LoginRateLimiter } from "./ratelimit";
import { deriveSessionKey, SESSION_MAX_AGE_SECONDS, signSessionToken } from "./session";

export type LoginAttemptResult =
  | { ok: true; token: string }
  | { ok: false; reason: "invalid" }
  | {
      ok: false;
      reason: "limited";
      /** 距离可重试的秒数（取来源/账号/全局各维度限流解除的较大值，用于 Retry-After） */
      retryAfterSeconds: number;
    };

export interface LoginAttemptParams {
  username: unknown;
  password: unknown;
  /** 来源限流键（代理注入的客户端地址，见 clientKeyFromRequest） */
  clientKey: string;
  config: AuthConfig;
  limiter: LoginRateLimiter;
  /** 可注入的当前时间（毫秒），便于测试 */
  now?: number;
}

/** 账号维度的限流键：user: 前缀与来源键分空间；非字符串/空账号不产生账号键。 */
function usernameLimitKey(username: unknown): string | null {
  return typeof username === "string" && username.length > 0 ? `user:${username}` : null;
}

export async function attemptLogin(params: LoginAttemptParams): Promise<LoginAttemptResult> {
  const { username, password, clientKey, config, limiter } = params;
  const now = params.now ?? Date.now();

  const limitKeys = [clientKey];
  const userKey = usernameLimitKey(username);
  if (userKey) limitKeys.push(userKey);

  const limitedNow =
    limiter.isGloballyLimited(now) || limitKeys.some((key) => limiter.isLimited(key, now));
  if (limitedNow) {
    const retryAfterSeconds = Math.max(
      ...limitKeys.map((key) => limiter.retryAfterSeconds(key, now)),
      limiter.globalRetryAfterSeconds(now),
    );
    return { ok: false, reason: "limited", retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  const credentialsOk =
    typeof username === "string" &&
    typeof password === "string" &&
    verifyCredentials({ username, password }, config);

  if (!credentialsOk) {
    for (const key of limitKeys) limiter.recordFailure(key, now);
    return { ok: false, reason: "invalid" };
  }

  for (const key of limitKeys) limiter.reset(key);

  const seconds = Math.floor(now / 1000);
  const key = await deriveSessionKey(config.secret, config.password);
  const token = await signSessionToken(
    {
      sub: config.username,
      iat: seconds,
      exp: seconds + SESSION_MAX_AGE_SECONDS,
    },
    key,
  );
  return { ok: true, token };
}
