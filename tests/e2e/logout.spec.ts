// 顶栏退出登录 E2E（Issue #49）：登录 → 顶栏「退出」→ 登录页 + Cookie 清除 →
// 直接访问页面 / API 被 middleware 拦截；并覆盖失败态（网络异常不跳转、会话仍有效）。
//
// 断言只基于用户可见行为与浏览器 Cookie，不依赖 class 或内部实现。
// globalSetup 每次运行前清空 E2E 测试库，用例不依赖跑序。

import { expect, test, type Page } from "@playwright/test";

import { E2E_AUTH } from "./env";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("账号").fill(E2E_AUTH.username);
  await page.getByLabel("密码").fill(E2E_AUTH.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();
}

test("顶栏退出：清除会话并回到登录页；失败时留在当前页", async ({ page, context }) => {
  await login(page);

  // 登录态：顶栏用户名旁出现「退出」按钮。
  const logoutButton = page.getByRole("button", { name: "退出", exact: true });
  await expect(logoutButton).toBeVisible();

  // 失败态：拦截退出请求模拟网络异常 → 停留在当前页 + 提示「退出失败，请重试」。
  await page.route("**/api/auth/logout", (route) => route.abort("failed"));
  await logoutButton.click();
  await expect(page.getByText("退出失败，请重试", { exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await page.unroute("**/api/auth/logout");

  // 失败后会话仍有效：刷新后仍在今日视图，退出按钮仍在。
  await page.reload();
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();

  // 成功：点击退出 → 整页跳转登录页，会话 Cookie 被清除。
  // E2E 服务是纯 HTTP 部署，能清掉 Cookie 即证明 Secure 属性按请求协议判断正确。
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "wd_session");
  expect(sessionCookie).toBeUndefined();

  // 登录页不渲染退出入口（未登录 / 会话无效时随导航一起隐藏）。
  await expect(page.getByRole("button", { name: "退出", exact: true })).toHaveCount(0);

  // 退出后直接访问页面 → 302 到 /login?next=…；直接访问 API → 401。
  await page.goto("/");
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === "/",
  );
  await page.goto("/board");
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === "/board",
  );
  const apiResponse = await page.request.get("/api/tasks?view=board");
  expect(apiResponse.status()).toBe(401);
});
