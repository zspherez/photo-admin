import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl } from "@/lib/spotify";
import { SESSION_COOKIE, hasWriteAccess } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (
    !(await hasWriteAccess(
      request.cookies.get(SESSION_COOKIE)?.value,
    ))
  ) {
    return NextResponse.json(
      { error: "Admin access is required to connect Spotify" },
      { status: 403 },
    );
  }
  const state = randomBytes(16).toString("hex");
  const url = buildAuthorizeUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set("spotify_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
