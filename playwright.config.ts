// Playwright 端到端配置（Issue #45，docs/01-architecture.md「测试」）：
// 一条核心旅程冒烟，覆盖 登录 → 快速添加 → 完成 → 看板。
//
// 运行前提：先 `npm run build`（webServer 用生产构建 `next start`，不是 next dev）。
// 首次还需 `npx playwright install chromium`（或 `npm run e2e:install`）。
//
// 隔离与失败现场：
// - webServer 运行在 E2E 专用端口 3100（与本地 npm run dev 的 3000 隔离），
//   环境变量由 tests/e2e/env.ts 注入：独立凭据 + 独立 SQLite 库 prisma/e2e-test.db；
// - reuseExistingServer 仅本地开启（CI 关闭），便于中断后复用已启动的 E2E 服务；
// - 失败保留 screenshot + trace（test-results/），并生成 playwright-report/，均不入库。

import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_ENV } from "./tests/e2e/env";

export default defineConfig({
  testDir: "./tests/e2e",
  // 共享同一个 SQLite 测试库：串行执行，避免将来多用例并发写库互相干扰。
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run e2e:serve",
    url: E2E_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: E2E_ENV,
  },
});
