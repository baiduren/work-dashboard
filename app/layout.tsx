import type { Metadata } from "next";
import Link from "next/link";

import { getCurrentUsername } from "@/lib/auth/current-user";

import "./globals.css";

export const metadata: Metadata = {
  title: "个人工作台",
  description: "本地优先的个人任务工作台",
};

// 最小应用外壳（Issue #21；Issue #27 增加页面导航；Issue #31 增加「看板」导航）：
// 登录后顶栏提供「今日 / 看板 / 项目」导航，
// 未登录 / 会话无效（如登录页）时只显示应用名（导航随会话隐藏）。
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const username = await getCurrentUsername();
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900 antialiased">
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-5">
              <span className="text-sm font-semibold text-neutral-900">个人工作台</span>
              {username ? (
                <nav aria-label="页面导航" className="flex items-center gap-4">
                  <Link
                    href="/"
                    className="text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    今日
                  </Link>
                  <Link
                    href="/board"
                    className="text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    看板
                  </Link>
                  <Link
                    href="/projects"
                    className="text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    项目
                  </Link>
                </nav>
              ) : null}
            </div>
            {username ? (
              <span className="max-w-[10rem] truncate text-sm text-neutral-500" title={username}>
                {username}
              </span>
            ) : null}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
