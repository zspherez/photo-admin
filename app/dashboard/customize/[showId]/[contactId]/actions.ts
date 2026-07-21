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
  getOutreachSendabilityBatch,
  scheduleOutreach,
  sendOutreach,
} from "@/lib/sendOutreach";
import { normalizeEmail } from "@/lib/resend";
import {
  formatScheduledTime,
  getNextMondaySlot,
  getNextNormalOutreachDispatch,
  isWeekendET,
} from "@/lib/schedule";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import type { TrajectoryActionContext } from "@/lib/trajectoryActiveRun";

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
  const normalizedSelectedEmail = normalizeEmail(selectedContact?.email ?? "");
  const suppression = normalizedSelectedEmail
    ? await db.emailSuppression.findUnique({
        where: { normalizedEmail: normalizedSelectedEmail },
        select: { normalizedEmail: true },
      })
    : null;
  const selectionError = customizeRecipientSelectionError({
    contextContact,
    selectedContact,
    artistContacts,
    suppressedEmails: suppression ? [suppression.normalizedEmail] : [],
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

  const [sendability] = await getOutreachSendabilityBatch([
    { showId, contactId: selectedContactId, singleRecipient: true },
  ]);
  if (!sendability?.sendable) {
    return actionError(
      selectedContactId,
      sendability?.reason ?? "Email outreach is unavailable",
    );
  }

  const input = {
    showId,
    contactId: selectedContactId,
    subjectOverride,
    htmlOverride,
    singleRecipient: true,
    expectedRecipientIdentity,
    trajectoryContext: context.trajectoryContext ?? undefined,
  };
  const result =
    intent === "queue"
      ? await scheduleOutreach(input, getNextNormalOutreachDispatch())
      : isWeekendET()
        ? await scheduleOutreach(input, getNextMondaySlot())
        : await sendOutreach(input);
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
