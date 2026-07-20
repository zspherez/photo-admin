"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  dashboardResultHref,
  festivalReturnPath,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import {
  MANUAL_OUTREACH_HTML,
  MANUAL_OUTREACH_MARKER_WHERE,
  MANUAL_OUTREACH_SUBJECT,
  REUSABLE_MANUAL_OUTREACH_MARKER_WHERE,
  manualMarkBlockingReason,
  removeManualOutreachMarker,
} from "@/lib/manualOutreach";
import {
  cancelScheduledOutreach,
  scheduleOutreach,
  scheduleFollowUp,
  sendFollowUp,
  sendOutreach,
} from "@/lib/sendOutreach";
import { isWeekendET, getNextMondaySlot } from "@/lib/schedule";
import { requireServerActionAuth } from "@/lib/auth";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import {
  festivalLeadTimeError,
  festivalLeadTimeExclusion,
} from "@/lib/festivalEligibility";

async function withSerializableRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code
          : null;
      if ((code === "P2002" || code === "P2034") && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Unable to update manual outreach");
}

export async function sendNowAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!showId || !contactId) {
    redirect(
      dashboardResultHref(returnTo, "error", "Missing show or email contact")
    );
  }
  const contact = await db.contact.findFirst({
    where: { id: contactId, state: "active" },
    select: { email: true },
  });
  if (!contact?.email?.trim()) {
    redirect(
      dashboardResultHref(returnTo, "error", "Selected contact has no email")
    );
  }

  if (isWeekendET()) {
    const scheduledFor = getNextMondaySlot();
    const result = await scheduleOutreach({ showId, contactId }, scheduledFor);
    refreshWorkflowViews(returnTo, [
      "/outreach",
      festivalReturnPath(showId),
    ]);
    if (result.ok) {
      redirect(dashboardResultHref(returnTo, "scheduled"));
    } else {
      redirect(
        dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
      );
    }
  }
  const result = await sendOutreach({ showId, contactId });
  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  if (result.ok) {
    redirect(dashboardResultHref(returnTo, "sent"));
  } else {
    redirect(
      dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
    );
  }
}

export async function sendFollowUpAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const parentOutreachId = String(
    formData.get("parentOutreachId") ?? "",
  ).trim();
  if (!parentOutreachId) {
    redirect(
      dashboardResultHref(returnTo, "error", "Missing original outreach"),
    );
  }

  const parent = await db.outreach.findUnique({
    where: { id: parentOutreachId, kind: "original" },
    select: { showId: true },
  });
  if (!parent) {
    redirect(
      dashboardResultHref(returnTo, "error", "Original outreach not found"),
    );
  }

  const result = isWeekendET()
    ? await scheduleFollowUp(parentOutreachId, getNextMondaySlot())
    : await sendFollowUp(parentOutreachId);
  refreshWorkflowViews(returnTo, [
    "/outreach",
    festivalReturnPath(parent.showId),
  ]);
  if (result.ok) {
    redirect(
      dashboardResultHref(
        returnTo,
        result.scheduled ? "followup_scheduled" : "followup_sent",
      ),
    );
  }
  redirect(
    dashboardResultHref(
      returnTo,
      "error",
      result.error ?? "Follow-up failed",
    ),
  );
}

export async function cancelScheduledAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const outreachId = String(formData.get("outreachId") ?? "").trim();
  if (!outreachId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach"));
  }

  const result = await cancelScheduledOutreach(outreachId);
  refreshWorkflowViews(returnTo, [
    "/outreach",
    ...(result.showId ? [festivalReturnPath(result.showId)] : []),
  ]);
  if (result.cancelled) {
    redirect(dashboardResultHref(returnTo, "cancelled"));
  }
  redirect(
    dashboardResultHref(
      returnTo,
      "error",
      "Scheduled or retry send is no longer cancellable"
    )
  );
}

export async function dismissShowAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showIds = Array.from(
    new Set(
      formData
        .getAll("showId")
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
  if (showIds.length === 0) throw new Error("Missing show");
  await db.show.updateMany({
    where: { id: { in: showIds } },
    data: { dismissedAt: new Date() },
  });
  refreshWorkflowViews(returnTo, ["/festivals"]);
}

export async function restoreShowAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showIds = Array.from(
    new Set(
      formData
        .getAll("showId")
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  );
  if (showIds.length === 0) throw new Error("Missing show");
  await db.show.updateMany({
    where: { id: { in: showIds } },
    data: { dismissedAt: null },
  });
  refreshWorkflowViews(returnTo, ["/festivals"]);
}

export async function setInterestedAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const desired = String(formData.get("interested") ?? "");
  if (!showId || (desired !== "true" && desired !== "false")) {
    throw new Error("Missing show or interested state");
  }
  await db.show.update({
    where: { id: showId },
    data: { interestedAt: desired === "true" ? new Date() : null },
  });
  refreshWorkflowViews(returnTo);
}

// Record a send that happened outside the app (personal email, DM, etc.) so
// the dashboard reflects it as "Sent". Manual rows have no provider attempts,
// so immutable email history is never overwritten or deleted.
// Accepts either contactId (when a contact is known) or artistId (for
// artist-level "I reached out, no contact in the system" rows).
export async function markSentAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  let artistId = String(formData.get("artistId") ?? "").trim() || null;

  if (!showId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing show"));
  }
  if (contactId) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, state: "active" },
      select: { artistId: true },
    });
    if (!contact) {
      redirect(dashboardResultHref(returnTo, "error", "Contact not found"));
    }
    artistId = contact.artistId;
  }
  if (!artistId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach target"));
  }

  const result = await withSerializableRetry(async (tx) => {
    const [show, artist, association, rows, manualMarker] = await Promise.all([
      tx.show.findUnique({
        where: { id: showId },
        select: {
          id: true,
          isFestival: true,
          date: true,
          city: true,
          state: true,
          countryCode: true,
          edmtrainVenue: { select: { nycStatus: true } },
          syncStatus: true,
          dismissedAt: true,
        },
      }),
      tx.artist.findUnique({ where: { id: artistId }, select: { id: true } }),
      tx.showArtist.findUnique({
        where: { showId_artistId: { showId, artistId } },
        select: { showId: true },
      }),
      tx.outreach.findMany({
        where: { showId, artistId, kind: "original" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          status: true,
          contactId: true,
          providerMessageId: true,
          attemptCount: true,
          _count: { select: { sendAttempts: true } },
        },
      }),
      tx.outreach.findFirst({
        where: {
          showId,
          artistId,
          ...REUSABLE_MANUAL_OUTREACH_MARKER_WHERE,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      }),
    ]);
    if (!show) return { ok: false, error: "Show not found" };
    if (show.syncStatus !== "active") {
      return { ok: false, error: "Show is inactive" };
    }
    const leadTimeExclusion = festivalLeadTimeExclusion(show);
    if (leadTimeExclusion) {
      return {
        ok: false,
        error: festivalLeadTimeError(leadTimeExclusion),
      };
    }
    if (show.isFestival && show.dismissedAt) {
      return {
        ok: false,
        error: "Restore this festival before marking outreach",
      };
    }
    if (!artist) return { ok: false, error: "Artist not found" };
    if (!association) {
      return { ok: false, error: "Artist is not on this show" };
    }
    const blockingReason = manualMarkBlockingReason(
      rows.map((row) => ({
        status: row.status,
        providerMessageId: row.providerMessageId,
        attemptCount: row.attemptCount,
        sendAttemptCount: row._count.sendAttempts,
      }))
    );
    if (blockingReason) return { ok: false, error: blockingReason };

    const now = new Date();
    if (manualMarker) {
      await tx.outreach.update({
        where: { id: manualMarker.id },
        data: {
          status: "sent",
          sentAt: now,
          error: null,
          scheduledFor: null,
          claimedAt: null,
          claimToken: null,
        },
      });
      return { ok: true };
    }

    const contactSlotAvailable =
      contactId !== null && !rows.some((row) => row.contactId === contactId);
    await tx.outreach.create({
      data: {
        kind: "original",
        showId,
        artistId,
        contactId: contactSlotAvailable ? contactId : null,
        finalSubject: MANUAL_OUTREACH_SUBJECT,
        finalHtml: MANUAL_OUTREACH_HTML,
        status: "sent",
        sentAt: now,
      },
    });
    return { ok: true };
  });

  if (!result.ok) {
    redirect(
      dashboardResultHref(
        returnTo,
        "error",
        result.error
      )
    );
  }

  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  redirect(dashboardResultHref(returnTo, "marked"));
}

// Undo only rows that are provably manual markers. Provider attempts and
// preparation history remain immutable even when no provider ID was returned.
export async function unmarkSentAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const outreachId = String(formData.get("outreachId") ?? "").trim();
  if (!outreachId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach"));
  }

  const marker = await withSerializableRetry((tx) =>
    removeManualOutreachMarker(
      {
        async findById(id) {
          const row = await tx.outreach.findUnique({
            where: { id },
            select: {
              id: true,
              kind: true,
              showId: true,
              artistId: true,
              status: true,
              providerMessageId: true,
              attemptCount: true,
              finalSubject: true,
              finalHtml: true,
              _count: { select: { sendAttempts: true } },
            },
          });
          return row
            ? {
                id: row.id,
                kind: row.kind,
                showId: row.showId,
                artistId: row.artistId,
                status: row.status,
                providerMessageId: row.providerMessageId,
                attemptCount: row.attemptCount,
                sendAttemptCount: row._count.sendAttempts,
                finalSubject: row.finalSubject,
                finalHtml: row.finalHtml,
              }
            : null;
        },
        async deleteActiveMarker(id) {
          const deleted = await tx.outreach.deleteMany({
            where: {
              id,
              ...MANUAL_OUTREACH_MARKER_WHERE,
            },
          });
          return deleted.count === 1;
        },
      },
      outreachId
    )
  );
  if (!marker) {
    redirect(
      dashboardResultHref(
        returnTo,
        "error",
        "Only manual outreach marks can be removed"
      )
    );
  }
  refreshWorkflowViews(returnTo, [
    "/outreach",
    festivalReturnPath(marker.showId),
  ]);
  redirect(dashboardResultHref(returnTo, "unmarked"));
}
