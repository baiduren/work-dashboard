// 收件箱 E2E（Issue #50，docs/02-acceptance.md「收件箱验收」）：
// 未登录访问 /inbox 被重定向 → 登录 → 空收件箱空态 → 快速添加（不设日期）→
// 任务出现在收件箱且不在今日「今天到期」组 → 行内「设为今天」→
// 从收件箱消失并在今日「今天到期」组出现。
//
// 与 core-journey / logout 共用独立 E2E 库（tests/e2e/env.ts）：globalSetup 每次运行前
// 清空业务表；本用例只创建自己的任务，结束后已归类（无遗留 undated 任务）。

import { expect, test } from "@playwright/test";

import { E2E_AUTH } from "./env";

const TASK_TITLE = "E2E 收件箱归类任务";

test("收件箱：快速添加（不设日期）→ 设为今天 → 今日视图出现", async ({ page }) => {
  // 1. 未登录访问收件箱 → 302 到 /login?next=/inbox（middleware 生效）。
  await page.goto("/inbox");
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === "/inbox",
  );

  // 2. 登录后进入收件箱；空库显示空态文案。
  await page.getByLabel("账号").fill(E2E_AUTH.username);
  await page.getByLabel("密码").fill(E2E_AUTH.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/inbox");
  await expect(page.getByRole("heading", { name: "收件箱" })).toBeVisible();
  await expect(page.getByText("收件箱清空了，随手记点什么？")).toBeVisible();

  // 3. 收件箱快速添加（不设日期）→ 任务出现在收件箱列表。
  const quickAdd = page.getByLabel("任务标题");
  await quickAdd.fill(TASK_TITLE);
  await quickAdd.press("Enter");
  const inboxRow = page.getByRole("listitem").filter({ hasText: TASK_TITLE });
  await expect(inboxRow).toHaveCount(1);

  // 4. 不设日期的任务不出现在今日「今天到期」组（它属于「待安排」组，属预期）。
  await page.goto("/");
  const todaySection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /今天到期/ }) });
  await expect(todaySection.getByRole("listitem").filter({ hasText: TASK_TITLE })).toHaveCount(0);

  // 5. 回到收件箱，行内「设为今天」→ 行从收件箱消失（router.refresh 生效）。
  await page.goto("/inbox");
  await page.getByRole("button", { name: `设为今天：${TASK_TITLE}` }).click();
  await expect(inboxRow).toHaveCount(0);

  // 6. 今日视图「今天到期」组出现该任务。
  await page.goto("/");
  await expect(
    todaySection.getByRole("listitem").filter({ hasText: TASK_TITLE }),
  ).toBeVisible();
});
