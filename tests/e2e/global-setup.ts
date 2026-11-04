// Playwright globalSetup（Issue #45）：把独立的 E2E SQLite 库准备成“结构最新、数据为空”的状态。
//
// 运行时机：Playwright 的 webServer 插件先启动 next start（就绪探测不查数据库），
// 随后执行本文件，再跑用例；因此这里建库/迁移后，用例第一次查询时库已就绪。
//
// 隔离保证（docs/02-acceptance.md「端到端验收」）：
// - 只使用 tests/e2e/env.ts 的 E2E_DATABASE_URL（prisma/e2e-test.db），并在启动前断言
//   解析结果不等于开发库 prisma/dev.db；
// - 每次运行前执行 `prisma migrate deploy`（幂等，直接复用仓库迁移）并清空全部业务表，
//   用例可重复执行、不依赖跑序。

import { execFileSync } from "node:child_process";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { E2E_DATABASE_URL, E2E_DB_FILE } from "./env";

const repoRoot = path.resolve(__dirname, "..", "..");
const devDbFile = path.join(repoRoot, "prisma", "dev.db");

function assertIsolatedDatabase(): void {
  if (path.resolve(E2E_DB_FILE) === path.resolve(devDbFile)) {
    throw new Error("E2E 数据库解析到了开发库 prisma/dev.db，拒绝运行");
  }
}

/** 用仓库自带的 prisma CLI 应用迁移；显式传 env，确保只作用于 E2E 库。 */
function migrateE2eDatabase(): void {
  const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}

/** 按外键依赖顺序清空业务表（TaskTag → Tag → Task → Project）。 */
async function clearE2eDatabase(): Promise<void> {
  process.env.DATABASE_URL = E2E_DATABASE_URL;
  const prisma = new PrismaClient();
  try {
    await prisma.taskTag.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  assertIsolatedDatabase();
  migrateE2eDatabase();
  await clearE2eDatabase();
}
