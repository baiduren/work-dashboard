// 登录流程编排：限流检查 → 恒定时间凭据校验 → 签发会话令牌。
// 纯逻辑、可单测；route handler 只负责 HTTP 细节（docs/01-architecture.md「模块边界」）。

import type { AuthConfig } from "./config";
import { verifyCredentials } from "./password";
import { LoginRateLimiter } from "./ratelimit";
import { deriveSessionKey, SESSION_MAX_AGE_SECONDS, signSessionToken } from "./session";

export type LoginAttemptResult =
  | { ok: true; token: string }
  | { ok: false; reason: "invalid" | "limited" };

export interface LoginAttemptParams {
  username: unknown;
  password: unknown;
  /** 限流键（客户端 IP） */
  clientKey: string;
  config: AuthConfig;
  limiter: LoginRateLimiter;
  /** 可注入的当前时间（毫秒），便于测试 */
  now?: number;
}

export async function attemptLogin(params: LoginAttemptParams): Promise<LoginAttemptResult> {
  const { username, password, clientKey, config, limiter } = params;
  const now = params.now ?? Date.now();

  if (limiter.isLimited(clientKey, now)) {
    return { ok: false, reason: "limited" };
  }

  const credentialsOk =
    typeof username === "string" &&
    typeof password === "string" &&
    verifyCredentials({ username, password }, config);

  if (!credentialsOk) {
    limiter.recordFailure(clientKey, now);
    return { ok: false, reason: "invalid" };
  }

  limiter.reset(clientKey);

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
