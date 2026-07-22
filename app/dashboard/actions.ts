"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  dashboardResultHref,
  festivalReturnPath,
  withWorkflowReturnTo,
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
import {
  formatScheduledTime,
  getNextMondaySlot,
  getNextNormalOutreachDispatch,
  isWeekendET,
} from "@/lib/schedule";
import { requireServerActionAuth } from "@/lib/auth";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import {
  festivalLeadTimeError,
  festivalLeadTimeExclusion,
} from "@/lib/festivalEligibility";
import { recordTrajectoryFeedback } from "@/lib/trajectoryFeedback";
import {
  requireActionableTrajectoryRecommendation,
  requireActionableTrajectoryRecommendationInTransaction,
  trajectoryActionContextFromFormData,
  type TrajectoryActionContext,
} from "@/lib/trajectoryActiveRun";
import {
  emailContactsRequireSelection,
  pickEmailContact,
} from "@/lib/contactSelection";

async function trajectoryContext(
  formData: FormData,
  showId: string,
): Promise<TrajectoryActionContext | null> {
  const context = trajectoryActionContextFromFormData(formData, showId);
  if (context) await requireActionableTrajectoryRecommendation(context);
  return context;
}

function hasTrajectoryContext(formData: FormData): boolean {
  return ["recommendationId", "runId", "artistId"].some((key) =>
    Boolean(String(formData.get(key) ?? "").trim()),
  );
}

async function recordRecommendationDecision(
  formData: FormData,
  context: TrajectoryActionContext | null,
  action: "selected" | "declined" | "saved" | "dismissed" | "manual_override",
): Promise<void> {
  if (!context) return;
  const actionId = String(formData.get("trajectoryActionId") ?? "").trim();
  if (!actionId) throw new Error("Missing trajectory action identity");
  await recordTrajectoryFeedback({
    ...context,
    action,
    idempotencyKey: `recommendations/${action}/${actionId}`,
  });
}

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
  const recommendation = await trajectoryContext(formData, showId);
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
    const result = await scheduleOutreach(
      { showId, contactId, trajectoryContext: recommendation ?? undefined },
      scheduledFor,
    );
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
  const result = await sendOutreach({
    showId,
    contactId,
    trajectoryContext: recommendation ?? undefined,
  });
  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  if (result.ok) {
    redirect(dashboardResultHref(returnTo, "sent"));
  } else {
    redirect(
      dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
    );
  }
}

export async function queueForNextDispatchAction(formData: FormData) {
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = String(formData.get("showId") ?? "").trim();
  const contactId = String(formData.get("contactId") ?? "").trim();
  if (!showId || !contactId) {
    redirect(
      dashboardResultHref(returnTo, "error", "Missing show or email contact"),
    );
  }

  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { id: true, artistId: true },
  });
  if (!contact) {
    redirect(dashboardResultHref(returnTo, "error", "Contact not found"));
  }
  const artistContacts = await db.contact.findMany({
    where: { artistId: contact.artistId },
    select: {
      id: true,
      email: true,
      phone: true,
      state: true,
      isFullTeam: true,
    },
  });
  const defaultContact = pickEmailContact(artistContacts);
  if (!defaultContact || defaultContact.id !== contact.id) {
    redirect(
      dashboardResultHref(
        returnTo,
        "error",
        "Default email contact changed; refresh and try again",
      ),
    );
  }
  if (emailContactsRequireSelection(artistContacts)) {
    redirect(
      withWorkflowReturnTo(
        `/dashboard/customize/${encodeURIComponent(showId)}/${encodeURIComponent(contactId)}?intent=queue`,
        returnTo,
      ),
    );
  }

  const result = await scheduleOutreach(
    { showId, contactId },
    getNextNormalOutreachDispatch(),
  );
  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  if (result.ok) {
    redirect(
      dashboardResultHref(
        returnTo,
        "queued",
        result.scheduledFor
          ? formatScheduledTime(result.scheduledFor)
          : "the next dispatch",
      ),
    );
  }
  redirect(
    dashboardResultHref(
      returnTo,
      "error",
      result.error ?? "Unable to queue outreach",
    ),
  );
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
    select: { showId: true, artistId: true },
  });
  if (!parent) {
    redirect(
      dashboardResultHref(returnTo, "error", "Original outreach not found"),
    );
  }
  const recommendation = await trajectoryContext(formData, parent.showId);
  if (recommendation && recommendation.artistId !== parent.artistId) {
    redirect(
      dashboardResultHref(
        returnTo,
        "error",
        "Recommendation does not match original outreach",
      ),
    );
  }

  const result = isWeekendET()
    ? await scheduleFollowUp(
        parentOutreachId,
        getNextMondaySlot(),
        recommendation ?? undefined,
      )
    : await sendFollowUp(parentOutreachId, recommendation ?? undefined);
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
  const requestedShowId = String(formData.get("showId") ?? "").trim();
  if (requestedShowId) {
    const outreach = await db.outreach.findUnique({
      where: { id: outreachId },
      select: { showId: true, artistId: true },
    });
    if (!outreach || outreach.showId !== requestedShowId) {
      redirect(
        dashboardResultHref(returnTo, "error", "Scheduled outreach not found"),
      );
    }
    const recommendation = await trajectoryContext(formData, outreach.showId);
    if (recommendation && recommendation.artistId !== outreach.artistId) {
      redirect(
        dashboardResultHref(
          returnTo,
          "error",
          "Recommendation does not match scheduled outreach",
        ),
      );
    }
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
  if (hasTrajectoryContext(formData) && showIds.length !== 1) {
    throw new Error("Recommendation actions must target exactly one show");
  }
  const recommendation =
    showIds.length === 1 ? await trajectoryContext(formData, showIds[0]) : null;
  await db.show.updateMany({
    where: { id: { in: showIds } },
    data: { dismissedAt: new Date() },
  });
  await recordRecommendationDecision(
    formData,
    recommendation,
    "dismissed",
  );
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
  if (hasTrajectoryContext(formData) && showIds.length !== 1) {
    throw new Error("Recommendation actions must target exactly one show");
  }
  const recommendation =
    showIds.length === 1 ? await trajectoryContext(formData, showIds[0]) : null;
  await db.show.updateMany({
    where: { id: { in: showIds } },
    data: { dismissedAt: null },
  });
  await recordRecommendationDecision(formData, recommendation, "saved");
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
  const recommendation = await trajectoryContext(formData, showId);
  await db.show.update({
    where: { id: showId },
    data: { interestedAt: desired === "true" ? new Date() : null },
  });
  await recordRecommendationDecision(
    formData,
    recommendation,
    desired === "true" ? "selected" : "declined",
  );
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
  const recommendation = await trajectoryContext(formData, showId);
  if (contactId) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, state: "active" },
      select: { artistId: true },
    });
    if (!contact) {
      redirect(dashboardResultHref(returnTo, "error", "Contact not found"));
    }
    if (recommendation && contact.artistId !== recommendation.artistId) {
      redirect(
        dashboardResultHref(
          returnTo,
          "error",
          "Contact does not match the recommendation artist",
        ),
      );
    }
    artistId = contact.artistId;
  }
  if (!artistId) {
    redirect(dashboardResultHref(returnTo, "error", "Missing outreach target"));
  }
  if (recommendation && artistId !== recommendation.artistId) {
    redirect(
      dashboardResultHref(
        returnTo,
        "error",
        "Outreach target does not match the recommendation artist",
      ),
    );
  }
  const targetArtistId = artistId;

  const result = await withSerializableRetry(async (tx) => {
    const [show, artist, association, rows, manualMarker, currentContact] =
      await Promise.all([
        tx.show.findUnique({
          where: { id: showId },
          select: {
            id: true,
            isFestival: true,
            date: true,
            festivalNycStatus: true,
            syncStatus: true,
            dismissedAt: true,
          },
        }),
        tx.artist.findUnique({
          where: { id: targetArtistId },
          select: { id: true },
        }),
        tx.showArtist.findUnique({
          where: {
            showId_artistId: { showId, artistId: targetArtistId },
          },
          select: { showId: true },
        }),
        tx.outreach.findMany({
          where: {
            showId,
            artistId: targetArtistId,
            kind: "original",
          },
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
            artistId: targetArtistId,
            ...REUSABLE_MANUAL_OUTREACH_MARKER_WHERE,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
        }),
        contactId
          ? tx.contact.findUnique({
              where: { id: contactId },
              select: { artistId: true, state: true },
            })
          : Promise.resolve(null),
      ]);
    if (
      contactId &&
      (!currentContact ||
        currentContact.state !== "active" ||
        currentContact.artistId !== targetArtistId ||
        (recommendation &&
          currentContact.artistId !== recommendation.artistId))
    ) {
      return {
        ok: false,
        error: "Contact no longer matches the outreach artist",
      };
    }
    if (recommendation) {
      try {
        await requireActionableTrajectoryRecommendationInTransaction(
          tx,
          recommendation,
        );
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Trajectory recommendation is no longer actionable",
        };
      }
    }
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
          ...(recommendation
            ? {
                trajectoryRecommendationId:
                  recommendation.recommendationId,
              }
            : {}),
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
        artistId: targetArtistId,
        contactId: contactSlotAvailable ? contactId : null,
        finalSubject: MANUAL_OUTREACH_SUBJECT,
        finalHtml: MANUAL_OUTREACH_HTML,
        ...(recommendation
          ? {
              trajectoryRecommendationId: recommendation.recommendationId,
            }
          : {}),
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
  await recordRecommendationDecision(
    formData,
    recommendation,
    "manual_override",
  );
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
  const requestedShowId = String(formData.get("showId") ?? "").trim();
  if (requestedShowId) {
    const outreach = await db.outreach.findUnique({
      where: { id: outreachId },
      select: { showId: true, artistId: true },
    });
    if (!outreach || outreach.showId !== requestedShowId) {
      redirect(
        dashboardResultHref(returnTo, "error", "Manual outreach not found"),
      );
    }
    const recommendation = await trajectoryContext(formData, outreach.showId);
    if (recommendation && recommendation.artistId !== outreach.artistId) {
      redirect(
        dashboardResultHref(
          returnTo,
          "error",
          "Recommendation does not match manual outreach",
        ),
      );
    }
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
