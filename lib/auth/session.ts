// 会话令牌：HMAC-SHA256 签名与校验。
//
// 实现说明：
// - 只依赖 Web Crypto（crypto.subtle），同一模块可同时运行在
//   Node 运行时（route handlers）与 Edge 运行时（middleware.ts），不引入任何依赖；
// - 签名密钥由 AUTH_SESSION_SECRET 与当前密码共同派生，
//   满足 docs/adr/0004-authentication.md「换 secret 或改密码即全体失效」；
// - 令牌格式：`base64url(payload).base64url(hmac)`，payload 为
//   { sub: 用户名, iat: 签发时间, exp: 过期时间 }（unix 秒）；
// - 任何格式错误、签名不符或过期都视为未登录（返回 null），绝不抛出异常。

export const SESSION_COOKIE_NAME = "wd_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 天

export type SessionPayload = {
  /** 登录用户名 */
  sub: string;
  /** 签发时间（unix 秒） */
  iat: number;
  /** 过期时间（unix 秒） */
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_KEY_INFO = "work-dashboard:session:v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 由部署凭据派生会话签名密钥：HMAC-SHA256(secret, "work-dashboard:session:v1:" + password)。
 * 改密码或换 secret 都会得到不同密钥，旧会话全部失效。
 */
export async function deriveSessionKey(secret: string, password: string): Promise<CryptoKey> {
  const macKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", macKey, encoder.encode(`${SESSION_KEY_INFO}:${password}`));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    typeof record.iat === "number" &&
    Number.isFinite(record.iat) &&
    typeof record.exp === "number" &&
    Number.isFinite(record.exp)
  );
}

/** 签发会话令牌。调用方需先用 deriveSessionKey 得到签名密钥。 */
export async function signSessionToken(payload: SessionPayload, key: CryptoKey): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * 校验会话令牌：签名不符、格式非法（含篡改/截断）或已过期均返回 null。
 * HMAC 的签名比对由 crypto.subtle.verify 在原生层完成。
 */
export async function verifySessionToken(
  token: string | null | undefined,
  key: CryptoKey,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, tag] = parts;

  let tagBytes: Uint8Array<ArrayBuffer>;
  try {
    tagBytes = base64UrlDecode(tag);
  } catch {
    return null;
  }
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, tagBytes, encoder.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  if (!isSessionPayload(payload)) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** 会话 Cookie 属性：HttpOnly、SameSite=Lax、默认生产环境 Secure、7 天（docs/adr/0004-authentication.md）。 */
export function sessionCookieAttributes(
  maxAgeSeconds: number,
  options: { secure?: boolean } = {},
): {
  name: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure ?? process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * 判断当前请求是否经由 HTTPS（含反向代理的 x-forwarded-proto）。
 * 注意：x-forwarded-proto 的信任前提是代理会覆盖客户端传入的同名头，见 README「反向代理要求」。
 */
export function isSecureRequest(request: {
  headers: Headers;
  nextUrl?: { protocol: string };
}): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  return request.nextUrl?.protocol === "https:";
}

/**
 * 会话 Cookie 的 Secure 决策：
 * - `AUTH_COOKIE_SECURE=true/false` 显式覆盖；
 * - 未设置时按请求协议自动判断——HTTPS（含代理）为 true，纯 HTTP 部署为 false，
 *   否则浏览器会丢弃 Secure Cookie，表现为“登录成功但不跳转”（见 Issue）。
 */
export function secureCookieForRequest(request: {
  headers: Headers;
  nextUrl?: { protocol: string };
}): boolean {
  const override = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  return isSecureRequest(request);
}
