import { NextRequest, NextResponse } from "next/server";
import { buildArtistPlaylist } from "@/lib/artistPlaylist";

// One-off endpoint to build the "Festival Discovery — Mixed Bag" playlist from a
// hardcoded lineup. Lives under /api/cron/ so it's exempt from the login gate;
// guarded by its own throwaway token (not CRON_SECRET) and meant to be deleted
// after a single run. Long catalog crawl → allow up to 5 min.
export const maxDuration = 300;

const TOKEN = "73f4fcc32af7413eac900642";

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dryRun = request.nextUrl.searchParams.get("dry") === "1";
  try {
    const result = await buildArtistPlaylist({ dryRun });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
