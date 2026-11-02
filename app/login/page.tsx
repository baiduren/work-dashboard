import type { Metadata } from "next";
import { Suspense } from "react";

import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "登录 · 个人工作台",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
