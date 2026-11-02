import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "个人工作台",
  description: "本地优先的个人任务工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
