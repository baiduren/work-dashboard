// 核心用户旅程 E2E（Issue #45）：未登录重定向 → 错误密码 → 登录成功 → 快速添加
// → 完成 → 看板 done 列 → 刷新后状态保持。
//
// 断言只基于用户可见行为（页面文本、URL、列表/列状态），不依赖 class 或内部实现。
// 测试数据由 globalSetup 每次运行前清空；用例自身不依赖其他用例的跑序。

import { expect, test } from "@playwright/test";

import { E2E_AUTH } from "./env";

const TASK_TITLE = "E2E 冒烟任务";
const WRONG_PASSWORD = "wrong-password-for-e2e";

test("登录 → 快速添加 → 完成 → 看板 done 列（核心旅程）", async ({ page }) => {
  // 1. 未登录访问首页 → 302 到 /login?next=/（middleware 生效）。
  await page.goto("/");
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === "/",
  );
  await expect(page.getByRole("heading", { name: "个人工作台" })).toBeVisible();

  // 2. 错误密码 → 显示固定文案「账号或密码错误」，仍停留在登录页。
  await page.getByLabel("账号").fill(E2E_AUTH.username);
  await page.getByLabel("密码").fill(WRONG_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("账号或密码错误", { exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/login");

  // 3. 正确凭据 → 回到今日视图（next=/）。
  await page.getByLabel("密码").fill(E2E_AUTH.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();

  // 4. 快速添加任务（默认今天到期）→ 列表出现该任务。
  const quickAdd = page.getByLabel("任务标题");
  await quickAdd.fill(TASK_TITLE);
  await quickAdd.press("Enter");
  const taskRow = page.getByRole("listitem").filter({ hasText: TASK_TITLE });
  await expect(taskRow).toHaveCount(1);
  await expect(taskRow).toBeVisible();

  // 5. 点「完成」→ 该任务行从今日列表消失（toast 文案不作断言，以列表状态为准）。
  await page.getByRole("button", { name: `标记完成：${TASK_TITLE}` }).click();
  await expect(taskRow).toHaveCount(0);

  // 6. 看板 → 该任务出现在「已完成」列。
  await page.goto("/board");
  const doneColumn = page.getByRole("region", { name: "已完成列" });
  await expect(doneColumn).toBeVisible();
  await expect(doneColumn.getByText(TASK_TITLE, { exact: true })).toBeVisible();

  // 7. 刷新后状态保持：看板仍在 done 列，今日视图不再出现该任务。
  await page.reload();
  await expect(page.getByRole("region", { name: "已完成列" }).getByText(TASK_TITLE, { exact: true })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("listitem").filter({ hasText: TASK_TITLE })).toHaveCount(0);
});
