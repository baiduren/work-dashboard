import type { Metadata } from "next";

import { getCurrentUsername } from "@/lib/auth/current-user";

import "./globals.css";

export const metadata: Metadata = {
  title: "个人工作台",
  description: "本地优先的个人任务工作台",
};

// 最小应用外壳（Issue #21）：顶栏仅放应用名与当前登录账号名，不做导航链接。
// 未登录 / 会话无效（如登录页）时只显示应用名。
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
            <span className="text-sm font-semibold text-neutral-900">个人工作台</span>
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
