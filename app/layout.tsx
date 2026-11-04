import type { Metadata } from "next";
import Link from "next/link";

import { LogoutButton } from "@/components/logout-button";
import { getCurrentUsername } from "@/lib/auth/current-user";
import { listTasks } from "@/lib/db/tasks";

import "./globals.css";

export const metadata: Metadata = {
  title: "个人工作台",
  description: "本地优先的个人任务工作台",
};

// 最小应用外壳（Issue #21；Issue #27 增加页面导航；Issue #31 增加「看板」导航；Issue #44 增加「回顾」导航；Issue #49 增加「退出」入口；Issue #50 增加「收件箱」导航）：
// 登录后顶栏提供「今日 / 收件箱 / 看板 / 项目 / 回顾」导航，收件箱链接带未完成无日期任务数角标，
// 未登录 / 会话无效（如登录页）时只显示应用名（导航随会话隐藏）。
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const username = await getCurrentUsername();
  // 收件箱角标（Issue #50）：与 /inbox 页面同一查询 listTasks("undated")，不新建查询语义，
  // 保证角标与收件箱列表永远一致；未登录不查数据库。
  const undatedCount = username ? (await listTasks("undated", { now: new Date() })).length : 0;
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900 antialiased">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-5">
              {/* 小屏（<640px）登录态隐藏应用名，把宽度让给「今日 / 收件箱 / 看板 / 项目 / 回顾」导航；
                  未登录（登录页无导航）仍显示应用名。 */}
              <span
                className={
                  username
                    ? "hidden text-sm font-semibold text-neutral-900 sm:inline"
                    : "text-sm font-semibold text-neutral-900"
                }
              >
                个人工作台
              </span>
              {username ? (
                <nav aria-label="页面导航" className="flex items-center gap-3 sm:gap-4">
                  <Link
                    href="/"
                    className="whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    今日
                  </Link>
                  <Link
                    href="/inbox"
                    className="flex items-center gap-1 whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    收件箱
                    {undatedCount > 0 ? (
                      <span
                        data-testid="inbox-nav-badge"
                        title={`${undatedCount} 项待归类`}
                        className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs tabular-nums text-neutral-600"
                      >
                        {undatedCount}
                      </span>
                    ) : null}
                  </Link>
                  <Link
                    href="/board"
                    className="whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    看板
                  </Link>
                  <Link
                    href="/projects"
                    className="whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    项目
                  </Link>
                  <Link
                    href="/review"
                    className="whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    回顾
                  </Link>
                </nav>
              ) : null}
            </div>
            {username ? (
              <div className="flex items-center gap-3">
                <span className="hidden max-w-[10rem] truncate text-sm text-neutral-500 sm:inline" title={username}>
                  {username}
                </span>
                <LogoutButton />
              </div>
            ) : null}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
