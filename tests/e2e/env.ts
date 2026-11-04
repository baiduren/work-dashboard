// E2E 专用环境（Issue #45，docs/02-acceptance.md「端到端验收」）：
// 测试凭据、会话密钥与数据库地址集中在这里定义，用例内不硬编码；
// 同名环境变量可覆盖凭据（便于本地换一套测试账号），但 DATABASE_URL 固定指向
// 独立的 E2E SQLite 文件，绝不接受外部注入，避免误连开发库 prisma/dev.db。

import path from "node:path";

/** E2E 专用端口：与本地 npm run dev 的 3000 隔离，两者可同时存在。 */
export const E2E_PORT = 3100;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** 独立测试库；Prisma 把 SQLite 相对路径解析到 schema.prisma 所在目录（prisma/）。 */
export const E2E_DATABASE_URL = "file:./e2e-test.db";

/** Prisma 解析后的实际数据库文件：<仓库>/prisma/e2e-test.db（已被 .gitignore 的 *.db 忽略）。 */
export const E2E_DB_FILE = path.resolve(__dirname, "..", "..", "prisma", "e2e-test.db");

export const E2E_AUTH = {
  username: process.env.AUTH_USERNAME ?? "e2e-user",
  password: process.env.AUTH_PASSWORD ?? "e2e-test-password",
  // readAuthConfig 要求 ≥ 32 字符（docs/01-architecture.md「认证与访问控制」）。
  secret: process.env.AUTH_SESSION_SECRET ?? "e2e-test-session-secret-0123456789abcdef",
} as const;

/** 注入给 Playwright webServer（next start）的环境变量。 */
export const E2E_ENV: Record<string, string> = {
  DATABASE_URL: E2E_DATABASE_URL,
  AUTH_USERNAME: E2E_AUTH.username,
  AUTH_PASSWORD: E2E_AUTH.password,
  AUTH_SESSION_SECRET: E2E_AUTH.secret,
  // 今日 / 逾期边界按服务器时区计算（docs/01-architecture.md「接口约定」），固定时区让断言稳定。
  TZ: "Asia/Shanghai",
};
