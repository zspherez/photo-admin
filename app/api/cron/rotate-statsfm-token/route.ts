import { NextRequest, NextResponse } from "next/server";
import { rotateStatsfmToken } from "@/lib/statsfm";
import { isValidCronAuthorization } from "@/lib/cron-auth";

// Receives a freshly-extracted Stats.fm identityToken JWT (from the Playwright
// GitHub-Actions rotation cron) and installs it via the same path the
// Settings UI uses. Validates against /me before saving.
export async function POST(request: NextRequest) {
  if (!(await isValidCronAuthorization(request.headers.get("authorization")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  try {
    const result = await rotateStatsfmToken(token);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
