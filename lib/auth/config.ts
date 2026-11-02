// 认证配置：凭据只来自部署环境变量，不入库、不入仓库（docs/adr/0004-authentication.md）。
// 缺失或不符合要求时返回 null，调用方一律按“未配置/未登录”处理（fail closed）。

export type AuthConfig = {
  username: string;
  password: string;
  /** 会话签名密钥，至少 32 字符（docs/01-architecture.md「认证与访问控制」） */
  secret: string;
};

const MIN_SECRET_LENGTH = 32;

export function readAuthConfig(): AuthConfig | null {
  const username = process.env.AUTH_USERNAME?.trim() ?? "";
  const password = process.env.AUTH_PASSWORD ?? "";
  const secret = process.env.AUTH_SESSION_SECRET ?? "";
  if (!username || !password || secret.length < MIN_SECRET_LENGTH) return null;
  return { username, password, secret };
}
