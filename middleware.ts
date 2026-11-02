// 全站访问控制（docs/adr/0004-authentication.md、docs/01-architecture.md「认证与访问控制」）：
// - 放行：/login、/api/auth/login、静态资源（/_next/*、/favicon.ico、扩展名白名单文件）；
// - 其余页面：未登录 302 到 /login?next=…；
// - 其余 /api/*：未登录返回 401 JSON；
// - 变更类请求（POST/PUT/PATCH/DELETE）：校验 Origin 与 Host 一致，配合 SameSite=Lax 防 CSRF。
// 注意：middleware 跑在 Edge 运行时，只能导入 lib/auth/session 与 lib/auth/config
//（不得导入依赖 node:crypto 的 lib/auth/password）。

import { NextRequest, NextResponse } from "next/server";

import { readAuthConfig } from "@/lib/auth/config";
import { deriveSessionKey, SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * 静态资源：Next 内部资源、favicon，以及扩展名在白名单内的文件（public/ 下的资源）。
 * 只按扩展名白名单放行——「最后一段含点」一律放行会让未来新增的
 * /api/tasks.json、/notes/2026.11.02 之类路径绕过登录；其余路径（含带点的）都走认证。
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "svg",
  "css",
  "js",
  "webp",
  "woff",
  "woff2",
  "ico",
]);

function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return true;
  const lastSegment = pathname.split("/").pop() ?? "";
  const extensionDot = lastSegment.lastIndexOf(".");
  // 无扩展名，或以点开头（如 /.env、.well-known）→ 不按静态资源放行
  if (extensionDot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(lastSegment.slice(extensionDot + 1).toLowerCase());
}

/** 变更类请求要求 Origin 与 Host 一致；浏览器跨站请求必带 Origin，缺失视为非浏览器客户端。 */
function hasSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // 代理场景优先 x-forwarded-host，其次 Host 头，最后回退到请求 URL 的 host。
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function unauthorizedApiResponse(): NextResponse {
  return NextResponse.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();

  if (MUTATING_METHODS.has(method) && !hasSameOrigin(request)) {
    return NextResponse.json(
      { error: "拒绝跨站请求" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (isPublicPath(pathname) || isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  const config = readAuthConfig();
  const session = config
    ? await verifySessionToken(
        request.cookies.get(SESSION_COOKIE_NAME)?.value,
        await deriveSessionKey(config.secret, config.password),
      )
    : null;
  const authenticated = session !== null && session.sub === config?.username;

  if (authenticated) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return unauthorizedApiResponse();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl, 302);
}

export const config = {
  // _next/static、_next/image 与 favicon.ico 无需进入 middleware，直接在 matcher 排除。
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
