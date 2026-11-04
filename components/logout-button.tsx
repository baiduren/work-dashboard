"use client";

// 顶栏「退出」入口（Issue #49，docs/01-architecture.md「认证与访问控制」）：
// - 点击调用已有的 POST /api/auth/logout（服务端按请求协议清除会话 Cookie，本工单不改 API）；
// - 成功（200）→ window.location.assign("/login") 整页跳转，顺带清掉内存状态；
//   登录页是公开路径，middleware 放行；
// - 失败（网络异常 / 非 2xx）→ 停留在当前页，短暂显示「退出失败，请重试」，会话仍有效；
// - 进行中禁用按钮防重复点击；同源 fetch 自动带 Origin，middleware 的 CSRF 校验无需额外处理。

import { useEffect, useRef, useState } from "react";

const FAILURE_MESSAGE = "退出失败，请重试";
/** 失败提示短暂显示后自动复位，避免长期占位。 */
const FAILURE_RESET_MS = 3000;

export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  function showFailure() {
    setFailed(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setFailed(false);
      resetTimer.current = null;
    }, FAILURE_RESET_MS);
  }

  async function handleLogout() {
    if (pending) return;
    setFailed(false);
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setPending(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) {
        window.location.assign("/login");
        return;
      }
      showFailure();
    } catch {
      showFailure();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <span role="alert" className="whitespace-nowrap text-xs text-red-600">
          {FAILURE_MESSAGE}
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleLogout}
        disabled={pending}
        className="whitespace-nowrap text-sm text-neutral-500 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "退出中…" : "退出"}
      </button>
    </div>
  );
}
