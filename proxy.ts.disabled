import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isAuthenticated } from "@/lib/auth";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/resend/webhook",
  "/api/cron/",
  "/api/spotify/callback",
  "/_next/",
  "/favicon",
  "/robots",
  "/public/",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isAuthenticated(cookie)) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
