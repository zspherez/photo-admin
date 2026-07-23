import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, saveTokens } from "@/lib/spotify";
import { SESSION_COOKIE, hasWriteAccess } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const error = sp.get("error");
  const expectedState = request.cookies.get("spotify_oauth_state")?.value;

  const back = (status: string, detail?: string) => {
    const url = new URL("/settings/spotify", request.url);
    url.searchParams.set("status", status);
    if (detail) url.searchParams.set("detail", detail);
    const res = NextResponse.redirect(url);
    res.cookies.delete("spotify_oauth_state");
    return res;
  };

  if (
    !(await hasWriteAccess(
      request.cookies.get(SESSION_COOKIE)?.value,
    ))
  ) {
    return back("error", "admin_access_required");
  }
  if (error) return back("error", error);
  if (!code) return back("error", "missing_code");
  if (!state || !expectedState || state !== expectedState) return back("error", "state_mismatch");

  try {
    const tokens = await exchangeCodeForToken(code);
    await saveTokens(tokens);
    return back("connected");
  } catch (e) {
    return back("error", e instanceof Error ? e.message : "exchange_failed");
  }
}
