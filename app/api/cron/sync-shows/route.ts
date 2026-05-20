import { NextRequest, NextResponse } from "next/server";
import { syncEdmtrainFestivals, syncEdmtrainShows } from "@/lib/edmtrain";

// Daily: refresh EDMTrain NYC shows (90 days) + all US festivals (365 days).
// Triggered by Vercel cron (see vercel.json) — also callable manually with the right auth header.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const results: Record<string, unknown> = {};
  try {
    results.nyc = await syncEdmtrainShows(90);
  } catch (e) {
    results.nyc = { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    results.festivals = await syncEdmtrainFestivals(365);
  } catch (e) {
    results.festivals = { error: e instanceof Error ? e.message : String(e) };
  }
  return NextResponse.json({ ok: true, results });
}
