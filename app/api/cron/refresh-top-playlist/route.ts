import { NextRequest, NextResponse } from "next/server";
import { refreshTopTracksPlaylist } from "@/lib/topPlaylist";

// Daily (4am ET): rebuild the "top songs, last 4 weeks" Spotify playlist from
// stats.fm weekly data. Vercel adds `Authorization: Bearer <CRON_SECRET>` when
// CRON_SECRET is set — same auth as the other cron routes.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await refreshTopTracksPlaylist(50);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
