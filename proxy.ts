import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
  isAuthenticated,
} from "@/lib/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/test",
  "/api/auth/logout",
  "/api/integrations/trajectory-runs",
  "/api/release/runtime-verification",
  "/api/resend/webhook",
  "/api/spotify/callback",
  "/favicon.ico",
  "/logo.svg",
  "/robots.txt",
]);

const PUBLIC_PREFIXES = [
  "/api/contact-audit/",
  "/api/contact-research/",
  "/api/cron/",
  "/_next/",
];

function loginUrlFor(request: NextRequest): URL {
  const loginUrl = new URL("/login", request.url);
  const returnTo = request.nextUrl.pathname + request.nextUrl.search;
  if (returnTo !== "/") loginUrl.searchParams.set("next", returnTo);
  return loginUrl;
}

export function isServerActionRequest(request: NextRequest): boolean {
  return (
    request.method === "POST" &&
    Boolean(request.headers.get("next-action")?.trim())
  );
}

export function unauthenticatedResponse(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/") && isServerActionRequest(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = loginUrlFor(request);
  if (request.method === "GET" || request.method === "HEAD") {
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.redirect(loginUrl, 303);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const publicPath =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (
    PUBLIC_PATHS.has(publicPath) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  const configuration = getAuthConfiguration();
  if (configuration.mode === "misconfigured") {
    console.error(configuration.error);
    return NextResponse.json(
      { error: "Authentication is not configured on the server" },
      { status: 500 },
    );
  }
  if (configuration.mode === "open") return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isAuthenticated(cookie)) return NextResponse.next();

  return unauthenticatedResponse(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
