import { NextRequest, NextResponse } from "next/server";
import { syncEdmtrainShows } from "@/lib/edmtrain";

// Daily: refresh EDMTrain NYC shows for the next 90 days.
// Triggered by Vercel cron (see vercel.json) — also callable manually with the right auth header.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await syncEdmtrainShows(90);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron sync-shows] failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
