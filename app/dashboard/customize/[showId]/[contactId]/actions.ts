"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  dashboardResultHref,
  festivalReturnPath,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import { requireServerActionAuth } from "@/lib/auth";
import {
  customizeRecipientIdentityError,
  customizeRecipientSelectionError,
  type CustomizeRecipientContact,
  type CustomizeRecipientIdentity,
} from "@/lib/customizeRecipients";
import {
  getFollowUpEligibilityBatch,
  getOutreachSendabilityBatch,
  scheduleFollowUp,
  scheduleOutreach,
  sendFollowUp,
  sendOutreach,
} from "@/lib/sendOutreach";
import { normalizeEmail, normalizeEmails } from "@/lib/resend";
import {
  formatScheduledTime,
  getNextMondaySlot,
  getNextNormalOutreachDispatch,
  isWeekendET,
} from "@/lib/schedule";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import type { TrajectoryActionContext } from "@/lib/trajectoryActiveRun";
import {
  captureTrajectoryAction,
  trajectoryActionResultHref,
} from "@/lib/trajectoryActionError";
import {
  isRecipientDeliveryMode,
  isSelectableRecipientDeliveryMode,
} from "@/lib/recipientDelivery";

export interface CustomizeActionState {
  error: string | null;
  queuedFor: string | null;
  selectedContactId: string;
}

export interface CustomizeActionContext {
  showId: string;
  contextContactId: string;
  contextArtistId: string;
  returnTo: string;
  retryContactId: string | null;
  parentOutreachId: string | null;
  trajectoryContext: TrajectoryActionContext | null;
}

function actionError(
  selectedContactId: string,
  error: string,
): CustomizeActionState {
  return { error, queuedFor: null, selectedContactId };
}

export async function sendCustom(
  context: CustomizeActionContext,
  _previousState: CustomizeActionState,
  formData: FormData,
): Promise<CustomizeActionState> {
  await requireServerActionAuth(context.returnTo);
  const returnTo = workflowReturnPath(context.returnTo);
  const showId = context.showId.trim();
  const contextContactId = context.contextContactId.trim();
  const selectedContactId = String(
    formData.get("selectedContactId") ?? "",
  ).trim();
  const expectedRecipientEmail = String(
    formData.get("expectedRecipientEmail") ?? "",
  ).trim();
  const expectedRecipientArtistId = String(
    formData.get("expectedRecipientArtistId") ?? "",
  ).trim();
  const expectedRecipientUpdatedAt = String(
    formData.get("expectedRecipientUpdatedAt") ?? "",
  ).trim();
  const subjectOverride = String(formData.get("subject") ?? "");
  const htmlOverride = String(formData.get("html") ?? "");
  const recipientDeliveryModeValue = String(
    formData.get("recipientDeliveryMode") ?? "",
  );
  if (!isRecipientDeliveryMode(recipientDeliveryModeValue)) {
    return actionError(selectedContactId, "Unknown recipient delivery mode");
  }
  const intent = String(formData.get("intent") ?? "send");
  if (intent !== "send" && intent !== "queue") {
    return actionError(selectedContactId, "Unknown email action");
  }

  if (!showId || !contextContactId || !selectedContactId) {
    return actionError(selectedContactId, "Select an email recipient");
  }
  if (
    context.retryContactId &&
    selectedContactId !== context.retryContactId
  ) {
    return actionError(
      selectedContactId,
      "An immutable retry must use its original selected contact",
    );
  }
  if (
    context.parentOutreachId &&
    selectedContactId !== contextContactId
  ) {
    return actionError(
      selectedContactId,
      "A follow-up must use the original outreach contact",
    );
  }

  const [contextContact, selectedContact] = await Promise.all([
    db.contact.findUnique({
      where: { id: contextContactId },
      select: {
        id: true,
        artistId: true,
        email: true,
        state: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.contact.findUnique({
      where: { id: selectedContactId },
      select: {
        id: true,
        artistId: true,
        email: true,
        state: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const artistContacts: CustomizeRecipientContact[] = contextContact
    ? await db.contact.findMany({
        where: { artistId: contextContact.artistId },
        select: {
          id: true,
          artistId: true,
          email: true,
          state: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    : [];
  if (
    contextContact &&
    contextContact.artistId !== context.contextArtistId
  ) {
    return actionError(
      selectedContactId,
      "Outreach artist context changed since this page loaded",
    );
  }
  const candidateEmails = normalizeEmails(
    artistContacts.flatMap((candidate) =>
      candidate.email ? [candidate.email] : [],
    ),
  );
  const suppressions =
    candidateEmails.length === 0
      ? []
      : await db.emailSuppression.findMany({
          where: { normalizedEmail: { in: candidateEmails } },
          select: { normalizedEmail: true },
        });
  const suppressedEmails = suppressions.map(
    (suppression) => suppression.normalizedEmail,
  );
  const selectionError = customizeRecipientSelectionError({
    contextContact,
    selectedContact,
    artistContacts,
    suppressedEmails,
  });
  if (selectionError) {
    return actionError(selectedContactId, selectionError);
  }
  const normalizedExpectedEmail = normalizeEmail(expectedRecipientEmail);
  const expectedRecipientIdentity: CustomizeRecipientIdentity | null =
    normalizedExpectedEmail &&
    expectedRecipientArtistId &&
    expectedRecipientUpdatedAt
      ? {
          contactId: selectedContactId,
          artistId: expectedRecipientArtistId,
          normalizedEmail: normalizedExpectedEmail,
          updatedAt: expectedRecipientUpdatedAt,
        }
      : null;
  if (!expectedRecipientIdentity) {
    return actionError(
      selectedContactId,
      "Selected recipient identity is missing or invalid",
    );
  }
  const identityError = customizeRecipientIdentityError(
    selectedContact,
    expectedRecipientIdentity,
  );
  if (identityError) {
    return actionError(selectedContactId, identityError);
  }

  let immutableRetryDeliveryMode: string | null = null;
  if (context.parentOutreachId) {
    const [eligibility] = await getFollowUpEligibilityBatch([
      context.parentOutreachId,
    ]);
    if (!eligibility?.eligible) {
      return actionError(
        selectedContactId,
        eligibility?.reason ?? "Follow-up is unavailable",
      );
    }
    if (eligibility.mode === "retry") {
      immutableRetryDeliveryMode =
        eligibility.recipientDeliveryMode ?? null;
    }
  } else {
    const [sendability] = await getOutreachSendabilityBatch([
      { showId, contactId: selectedContactId, allContacts: true },
    ]);
    if (!sendability?.sendable) {
      return actionError(
        selectedContactId,
        sendability?.reason ?? "Email outreach is unavailable",
      );
    }
    if (sendability.mode === "retry") {
      immutableRetryDeliveryMode =
        sendability.recipientDeliveryMode ?? null;
    }
  }
  if (
    immutableRetryDeliveryMode !== null &&
    recipientDeliveryModeValue !== immutableRetryDeliveryMode
  ) {
    return actionError(
      selectedContactId,
      "An immutable retry must use its original recipient delivery mode",
    );
  }
  if (
    recipientDeliveryModeValue === "legacy_multi_to" &&
    immutableRetryDeliveryMode !== "legacy_multi_to"
  ) {
    return actionError(
      selectedContactId,
      "Legacy multi-recipient delivery is allowed only for its immutable retry",
    );
  }
  if (
    recipientDeliveryModeValue !== "legacy_multi_to" &&
    !isSelectableRecipientDeliveryMode(recipientDeliveryModeValue)
  ) {
    return actionError(selectedContactId, "Unknown recipient delivery mode");
  }

  const capturedResult = await captureTrajectoryAction(returnTo, () =>
    context.parentOutreachId
      ? intent === "queue"
        ? scheduleFollowUp(
            context.parentOutreachId,
            getNextNormalOutreachDispatch(),
            context.trajectoryContext ?? undefined,
            {
              subjectOverride,
              htmlOverride,
              recipientDeliveryMode: recipientDeliveryModeValue,
            },
          )
        : isWeekendET()
          ? scheduleFollowUp(
              context.parentOutreachId,
              getNextMondaySlot(),
              context.trajectoryContext ?? undefined,
              {
                subjectOverride,
                htmlOverride,
                recipientDeliveryMode: recipientDeliveryModeValue,
              },
            )
          : sendFollowUp(
              context.parentOutreachId,
              context.trajectoryContext ?? undefined,
              {
                subjectOverride,
                htmlOverride,
                recipientDeliveryMode: recipientDeliveryModeValue,
              },
            )
      : intent === "queue"
        ? scheduleOutreach(
            {
              showId,
              contactId: selectedContactId,
              subjectOverride,
              htmlOverride,
              allContacts: true,
              recipientDeliveryMode: recipientDeliveryModeValue,
              expectedRecipientIdentity,
              trajectoryContext: context.trajectoryContext ?? undefined,
            },
            getNextNormalOutreachDispatch(),
          )
        : isWeekendET()
          ? scheduleOutreach(
              {
                showId,
                contactId: selectedContactId,
                subjectOverride,
                htmlOverride,
                allContacts: true,
                recipientDeliveryMode: recipientDeliveryModeValue,
                expectedRecipientIdentity,
                trajectoryContext: context.trajectoryContext ?? undefined,
              },
              getNextMondaySlot(),
            )
          : sendOutreach({
              showId,
              contactId: selectedContactId,
              subjectOverride,
              htmlOverride,
              allContacts: true,
              recipientDeliveryMode: recipientDeliveryModeValue,
              expectedRecipientIdentity,
              trajectoryContext: context.trajectoryContext ?? undefined,
            }),
  );
  if (!capturedResult.ok) {
    redirect(capturedResult.errorHref);
  }
  const result = capturedResult.value;
  const trajectoryErrorHref = trajectoryActionResultHref(returnTo, result);
  if (trajectoryErrorHref) {
    redirect(trajectoryErrorHref);
  }
  if (!result.ok) {
    return actionError(
      selectedContactId,
      result.error ?? "Email outreach failed",
    );
  }

  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  if (intent === "queue" && result.scheduledFor) {
    return {
      error: null,
      queuedFor: formatScheduledTime(result.scheduledFor),
      selectedContactId,
    };
  }
  redirect(
    dashboardResultHref(
      returnTo,
      result.scheduled ? "scheduled" : "sent",
    ),
  );
}
