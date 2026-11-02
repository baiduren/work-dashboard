import { describe, expect, it } from "vitest";

import {
  deriveSessionKey,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieAttributes,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from "../lib/auth/session";

// 覆盖 docs/02-acceptance.md「认证验收」：
// 签名会话可校验、篡改/截断视为未登录、换 secret 或改密码即全体失效。

const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "test-password";
const USERNAME = "admin";

// 签发/过期时间相对当前时间，保证未过期的用例真的未过期
const NOW_SECONDS = Math.floor(Date.now() / 1000);

async function makeKey(secret = SECRET, password = PASSWORD): Promise<CryptoKey> {
  return deriveSessionKey(secret, password);
}

async function makeToken(
  payload: SessionPayload,
  key: CryptoKey,
): Promise<string> {
  return signSessionToken(payload, key);
}

function validPayload(): SessionPayload {
  return { sub: USERNAME, iat: NOW_SECONDS, exp: NOW_SECONDS + SESSION_MAX_AGE_SECONDS };
}

describe("会话令牌签名与校验", () => {
  it("签发后可校验，载荷包含用户名与签发/过期时间", async () => {
    const key = await makeKey();
    const token = await makeToken(validPayload(), key);
    const session = await verifySessionToken(token, key);
    expect(session).not.toBeNull();
    expect(session?.sub).toBe(USERNAME);
    expect(session?.iat).toBe(NOW_SECONDS);
    expect(session?.exp).toBe(NOW_SECONDS + SESSION_MAX_AGE_SECONDS);
  });

  it("有效期常量为 7 天", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("篡改载荷后校验失败（视为未登录）", async () => {
    const key = await makeKey();
    const token = await makeToken(validPayload(), key);
    const [body, tag] = token.split(".");
    const tamperedBody = `${body!.slice(0, -2)}xZ`;
    expect(await verifySessionToken(`${tamperedBody}.${tag}`, key)).toBeNull();
  });

  it("篡改签名后校验失败（视为未登录）", async () => {
    const key = await makeKey();
    const token = await makeToken(validPayload(), key);
    const [body, tag] = token.split(".");
    const tamperedTag = `${tag!.slice(0, -2)}xZ`;
    expect(await verifySessionToken(`${body}.${tamperedTag}`, key)).toBeNull();
  });

  it("截断的令牌校验失败（视为未登录）", async () => {
    const key = await makeKey();
    const token = await makeToken(validPayload(), key);
    expect(await verifySessionToken(token.slice(0, token.length - 5), key)).toBeNull();
  });

  it.each(["", "garbage", "a.b.c", "aaa.bbb", "..", "x."])(
    "非法格式 %j 校验失败且不抛异常",
    async (token) => {
      const key = await makeKey();
      expect(await verifySessionToken(token, key)).toBeNull();
    },
  );

  it("换 secret 后旧令牌全部失效", async () => {
    const token = await makeToken(validPayload(), await makeKey());
    const otherKey = await makeKey("another-secret-0123456789abcdef0123456789abcdef", PASSWORD);
    expect(await verifySessionToken(token, otherKey)).toBeNull();
  });

  it("改密码后旧令牌全部失效", async () => {
    const token = await makeToken(validPayload(), await makeKey());
    const otherKey = await makeKey(SECRET, "changed-password");
    expect(await verifySessionToken(token, otherKey)).toBeNull();
  });

  it("过期的令牌校验失败", async () => {
    const key = await makeKey();
    const expired = await makeToken(
      { sub: USERNAME, iat: NOW_SECONDS - 100, exp: NOW_SECONDS - 1 },
      key,
    );
    expect(await verifySessionToken(expired, key)).toBeNull();
  });

  it("载荷字段缺失或类型不对时校验失败（签名有效也不放行）", async () => {
    const key = await makeKey();
    const badPayloads = [
      { iat: NOW_SECONDS, exp: NOW_SECONDS + 100 },
      { sub: 1, iat: NOW_SECONDS, exp: NOW_SECONDS + 100 },
      { sub: USERNAME, iat: "x", exp: NOW_SECONDS + 100 },
      { sub: USERNAME, iat: NOW_SECONDS },
    ];
    for (const bad of badPayloads) {
      const body = Buffer.from(JSON.stringify(bad)).toString("base64url");
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      const token = `${body}.${Buffer.from(signature).toString("base64url")}`;
      expect(await verifySessionToken(token, key)).toBeNull();
    }
  });

  it("载荷里的 Unicode 用户名可完整往返", async () => {
    const key = await makeKey();
    const token = await makeToken({ sub: "用户甲", iat: NOW_SECONDS, exp: NOW_SECONDS + 100 }, key);
    const session = await verifySessionToken(token, key);
    expect(session?.sub).toBe("用户甲");
  });
});

describe("会话 Cookie 属性", () => {
  it("HttpOnly、SameSite=Lax、路径根、7 天", () => {
    const attributes = sessionCookieAttributes(SESSION_MAX_AGE_SECONDS);
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.sameSite).toBe("lax");
    expect(attributes.path).toBe("/");
    expect(attributes.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("生产环境启用 Secure，非生产不启用", () => {
    const env = process.env as { NODE_ENV?: string };
    const original = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      expect(sessionCookieAttributes(60).secure).toBe(true);
      env.NODE_ENV = "development";
      expect(sessionCookieAttributes(60).secure).toBe(false);
    } finally {
      env.NODE_ENV = original;
    }
  });
});
