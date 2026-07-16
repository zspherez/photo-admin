"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { dashboardResultHref } from "@/lib/dashboardReturnUrl";
import {
  MANUAL_OUTREACH_HTML,
  MANUAL_OUTREACH_MARKER_WHERE,
  MANUAL_OUTREACH_SUBJECT,
  manualMarkBlockingReason,
} from "@/lib/manualOutreach";
import {
  cancelScheduledOutreach,
  sendOutreach,
  scheduleOutreach,
} from "@/lib/sendOutreach";
import { isWeekendET, getNextMondaySlot } from "@/lib/schedule";
import { requireServerActionAuth } from "@/lib/auth";

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
  const showId = String(formData.get("showId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim();
  const returnTo = formData.get("returnTo");
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
    revalidatePath("/dashboard");
    revalidatePath(`/festivals/${showId}`);
    if (result.ok) {
      redirect(dashboardResultHref(returnTo, "scheduled"));
    } else {
      redirect(
        dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
      );
    }
  }

  const result = await sendOutreach({ showId, contactId });
  revalidatePath("/dashboard");
  revalidatePath(`/festivals/${showId}`);
  if (result.ok) {
    redirect(dashboardResultHref(returnTo, "sent"));
  } else {
    redirect(
      dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
    );
  }
}

export async function cancelScheduledAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const outreachId = String(formData.get("outreachId") ?? "").trim();
  const returnTo = formData.get("returnTo");
  if (!outreachId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach"));
  }

  const result = await cancelScheduledOutreach(outreachId);
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  if (result.showId) revalidatePath(`/festivals/${result.showId}`);
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
  await requireServerActionAuth("/dashboard");
  const showId = String(formData.get("showId") ?? "").trim();
  if (!showId) throw new Error("Missing show");
  await db.show.update({ where: { id: showId }, data: { dismissedAt: new Date() } });
  revalidatePath("/dashboard");
}

export async function restoreShowAction(formData: FormData) {
  await requireServerActionAuth("/dashboard");
  const showId = String(formData.get("showId") ?? "").trim();
  if (!showId) throw new Error("Missing show");
  await db.show.update({ where: { id: showId }, data: { dismissedAt: null } });
  revalidatePath("/dashboard");
}

export async function setInterestedAction(formData: FormData) {
  await requireServerActionAuth("/dashboard");
  const showId = String(formData.get("showId") ?? "").trim();
  const desired = String(formData.get("interested") ?? "");
  if (!showId || (desired !== "true" && desired !== "false")) {
    throw new Error("Missing show or interested state");
  }
  await db.show.update({
    where: { id: showId },
    data: { interestedAt: desired === "true" ? new Date() : null },
  });
  revalidatePath("/dashboard");
}

// Record a send that happened outside the app (personal email, DM, etc.) so
// the dashboard reflects it as "Sent". Manual rows have no provider attempts,
// so immutable email history is never overwritten or deleted.
// Accepts either contactId (when a contact is known) or artistId (for
// artist-level "I reached out, no contact in the system" rows).
export async function markSentAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const showId = String(formData.get("showId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  let artistId = String(formData.get("artistId") ?? "").trim() || null;
  const returnTo = formData.get("returnTo");

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
      tx.show.findUnique({ where: { id: showId }, select: { id: true } }),
      tx.artist.findUnique({ where: { id: artistId }, select: { id: true } }),
      tx.showArtist.findUnique({
        where: { showId_artistId: { showId, artistId } },
        select: { showId: true },
      }),
      tx.outreach.findMany({
        where: { showId, artistId },
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
          ...MANUAL_OUTREACH_MARKER_WHERE,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      }),
    ]);
    if (!show) return { ok: false, error: "Show not found" };
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

  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  revalidatePath(`/festivals/${showId}`);
  redirect(dashboardResultHref(returnTo, "marked"));
}

// Undo only rows that are provably manual markers. Provider attempts and
// preparation history remain immutable even when no provider ID was returned.
export async function unmarkSentAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const outreachId = String(formData.get("outreachId") ?? "").trim();
  const returnTo = formData.get("returnTo");
  if (!outreachId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach"));
  }

  const result = await db.outreach.deleteMany({
    where: {
      id: outreachId,
      ...MANUAL_OUTREACH_MARKER_WHERE,
    },
  });
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
  if (result.count === 1) {
    redirect(dashboardResultHref(returnTo, "unmarked"));
  }
  redirect(
    dashboardResultHref(
      returnTo,
      "error",
      "Only manual outreach marks can be removed"
    )
  );
}
