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
  customizeRecipientSelectionError,
  type CustomizeRecipientContact,
} from "@/lib/customizeRecipients";
import {
  getOutreachSendabilityBatch,
  scheduleOutreach,
  sendOutreach,
} from "@/lib/sendOutreach";
import { normalizeEmail } from "@/lib/resend";
import { getNextMondaySlot, isWeekendET } from "@/lib/schedule";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";

export interface CustomizeActionState {
  error: string | null;
  selectedContactId: string;
}

export interface CustomizeActionContext {
  showId: string;
  contextContactId: string;
  returnTo: string;
}

function actionError(
  selectedContactId: string,
  error: string,
): CustomizeActionState {
  return { error, selectedContactId };
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
  const subjectOverride = String(formData.get("subject") ?? "");
  const htmlOverride = String(formData.get("html") ?? "");

  if (!showId || !contextContactId || !selectedContactId) {
    return actionError(selectedContactId, "Select an email recipient");
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
        },
      })
    : [];
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
  };
  const result = isWeekendET()
    ? await scheduleOutreach(input, getNextMondaySlot())
    : await sendOutreach(input);
  if (!result.ok) {
    return actionError(
      selectedContactId,
      result.error ?? "Email outreach failed",
    );
  }

  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  redirect(
    dashboardResultHref(
      returnTo,
      result.scheduled ? "scheduled" : "sent",
    ),
  );
}
