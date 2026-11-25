import { handleCallback } from "@vercel/queue";
import type { ScheduleQueueMessage } from "@vercel/schedules";
import { db } from "@/lib/db";
import { dispatchScheduledArbitraryEmail } from "@/lib/sendArbitraryEmail";
import { isCustomEmailDispatchWindow, OUTREACH_CLAIM_TIMEOUT_MS } from "@/lib/schedule";

export const maxDuration = 60;

export const POST = handleCallback<ScheduleQueueMessage<{ id: string }>>(
  async (message) => {
    if (!isCustomEmailDispatchWindow()) return;
    const startedAt = Date.now();

    let ids: string[];
    if (message.name === "custom-email-recovery" && message.source === "static") {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - OUTREACH_CLAIM_TIMEOUT_MS);
      const rows = await db.arbitraryEmail.findMany({
        where: {
          OR: [
            { status: { in: ["scheduled", "retry_scheduled"] }, nextAttemptAt: { lte: now } },
            { status: { in: ["queued", "sending"] }, nextAttemptAt: { lte: now }, claimedAt: { lte: staleBefore } },
          ],
        },
        select: { id: true },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        take: 20,
      });
      ids = rows.map((row) => row.id);
    } else if (
      message.source === "dynamic" &&
      message.namespace === "custom-emails" &&
      typeof message.payload?.id === "string" &&
      message.name === `email-${message.payload.id}` &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.payload.id)
    ) {
      ids = [message.payload.id];
    } else {
      throw new Error("Invalid custom email schedule message");
    }

    for (const id of ids) {
      if (!isCustomEmailDispatchWindow() || Date.now() - startedAt >= 20_000) return;
      const result = await dispatchScheduledArbitraryEmail(id);
      if (!result.ok && !result.retryScheduled) {
        console.error("Custom email dispatch failed", id, result.error);
        throw new Error(`Custom email dispatch failed: ${id}`);
      }
    }
  },
);
