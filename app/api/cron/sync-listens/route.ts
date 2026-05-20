import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncStatsfmTopArtists } from "@/lib/statsfm";
import { syncSpotifyListens } from "@/lib/spotify";
import { syncContactsFromSheet } from "@/lib/sheets";

// Daily: refresh listening signals + contacts from Sheet.
// Best-effort — failures in one source do not abort the others.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const results: Record<string, unknown> = {};

  for (const [name, fn] of [
    ["spotify", () => syncSpotifyListens()],
    [
      "statsfm",
      async () => {
        const cred = await db.integrationCredential.findUnique({ where: { provider: "statsfm" } });
        if (!cred?.meta) return { skipped: "no statsfm credential" };
        const { userId } = JSON.parse(cred.meta);
        const lifetime = await syncStatsfmTopArtists(userId, "lifetime", 500);
        const months = await syncStatsfmTopArtists(userId, "months", 200);
        const weeks = await syncStatsfmTopArtists(userId, "weeks", 200);
        return { lifetime, months, weeks };
      },
    ],
    ["sheets", () => syncContactsFromSheet("Artists")],
  ] as const) {
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ ok: true, results });
}
