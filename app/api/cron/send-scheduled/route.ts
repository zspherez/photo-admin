import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dispatchScheduledOutreach } from "@/lib/sendOutreach";

// Runs every 15 minutes on weekday mornings via Vercel cron.
// Dispatches outreach rows whose scheduledFor has passed.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const due = await db.outreach.findMany({
    where: {
      status: "scheduled",
      scheduledFor: { lte: new Date() },
    },
    select: { id: true },
    take: 50,
  });

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const row of due) {
    const result = await dispatchScheduledOutreach(row.id);
    results.push({ id: row.id, ok: result.ok, error: result.error ?? undefined });
  }

  return NextResponse.json({ ok: true, dispatched: results.length, results });
}
