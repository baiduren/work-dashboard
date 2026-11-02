// 读取当前请求的登录账号（供 Server Component 外壳展示）：
// 复用 middleware.ts 相同的校验链（config → 派生密钥 → 验签），并同样要求
// session.sub 与配置账号一致才算登录。配置缺失 / Cookie 缺失 / 验签失败
// 一律返回 null（fail closed），由调用方决定如何降级展示。
// 仅限服务端（Node 运行时）使用；Edge 运行时（middleware）请继续用 session.ts。

import { cookies } from "next/headers";

import { readAuthConfig } from "./config";
import { deriveSessionKey, SESSION_COOKIE_NAME, verifySessionToken } from "./session";

/** 当前登录账号名；未登录或会话无效时返回 null。 */
export async function getCurrentUsername(): Promise<string | null> {
  const config = readAuthConfig();
  if (!config) return null;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(
    token,
    await deriveSessionKey(config.secret, config.password),
  );
  return session !== null && session.sub === config.username ? session.sub : null;
}
