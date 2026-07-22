import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { workflowReturnPath } from "@/lib/dashboardReturnUrl";
import { getOutreachSendabilityBatch } from "@/lib/sendOutreach";
import {
  formatNextDispatchActionLabel,
  getNextNormalOutreachDispatch,
  isWeekendET,
} from "@/lib/schedule";
import {
  buildVarsForShow,
  ensureOriginalTemplateForShow,
} from "@/lib/template";
import { Card, CardBody } from "@/components/ui/card";
import { formatShowDate } from "@/lib/formatDate";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  contactDisplayValue,
  hasDirectOutreachNote,
  isDirectOutreachOnly,
} from "@/lib/contactDisplay";
import {
  customizeRecipientIdentity,
  eligibleCustomizeRecipientContacts,
  renderCustomizeRecipientContent,
} from "@/lib/customizeRecipients";
import { normalizeEmail, normalizeEmails } from "@/lib/resend";
import {
  CustomizeForm,
  type CustomizeRecipientOption,
} from "./customize-form";
import { sendCustom } from "./actions";
import {
  requireActionableTrajectoryRecommendation,
  type TrajectoryActionContext,
} from "@/lib/trajectoryActiveRun";

export const dynamic = "force-dynamic";

const getCustomizeContext = cache(
  async (showId: string, contactId: string) =>
    Promise.all([
      db.show.findUnique({ where: { id: showId } }),
      db.contact.findFirst({
        where: { id: contactId, state: "active" },
        include: { artist: true },
      }),
    ]),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ showId: string; contactId: string }>;
}): Promise<Metadata> {
  const { showId, contactId } = await params;
  const [show, contact] = await getCustomizeContext(showId, contactId);
  return {
    title:
      show && contact
        ? `Customize ${contact.artist.name} at ${
            show.eventName || show.venueName
          }`
        : "Customize outreach",
  };
}

function recipientLabel(contact: {
  email: string | null;
  name: string | null;
  role: string | null;
  isFullTeam: boolean;
}): string {
  const email = normalizeEmail(contact.email ?? "") ?? "No valid email";
  const identity = contact.name ? `${contact.name} <${email}>` : email;
  const details = [
    contact.role?.trim() || null,
    contact.isFullTeam ? "Full team marker" : null,
  ].filter((value): value is string => !!value);
  return details.length ? `${identity} · ${details.join(" · ")}` : identity;
}

export default async function CustomizePage({
  params,
  searchParams,
}: {
  params: Promise<{ showId: string; contactId: string }>;
  searchParams: Promise<{
    returnTo?: SearchParamValue;
    recommendationId?: SearchParamValue;
    runId?: SearchParamValue;
    artistId?: SearchParamValue;
    intent?: SearchParamValue;
  }>;
}) {
  const { showId, contactId } = await params;
  const search = await searchParams;
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const initialIntent =
    firstSearchParam(search.intent) === "queue" ? "queue" : "send";
  const [show, contact] = await getCustomizeContext(showId, contactId);
  if (!show || !contact) return notFound();
  const trajectoryValues = {
    recommendationId: firstSearchParam(search.recommendationId) ?? "",
    runId: firstSearchParam(search.runId) ?? "",
    artistId: firstSearchParam(search.artistId) ?? "",
  };
  const hasTrajectoryContext = Object.values(trajectoryValues).some(Boolean);
  const trajectoryContext: TrajectoryActionContext | null =
    hasTrajectoryContext &&
    trajectoryValues.recommendationId &&
    trajectoryValues.runId &&
    trajectoryValues.artistId
      ? { ...trajectoryValues, showId }
      : null;
  let trajectoryError: string | null = null;
  if (hasTrajectoryContext && !trajectoryContext) {
    trajectoryError = "Recommendation attribution is incomplete.";
  } else if (trajectoryContext) {
    if (trajectoryContext.artistId !== contact.artistId) {
      trajectoryError = "Recommendation does not match this artist.";
    } else {
      try {
        await requireActionableTrajectoryRecommendation(trajectoryContext);
      } catch (error) {
        trajectoryError =
          error instanceof Error
            ? error.message
            : "Recommendation is no longer actionable.";
      }
    }
  }
  const template = await ensureOriginalTemplateForShow(show);

  const artistContacts = await db.contact.findMany({
    where: { artistId: contact.artistId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      artistId: true,
      email: true,
      name: true,
      role: true,
      state: true,
      isFullTeam: true,
      createdAt: true,
      updatedAt: true,
    },
  });
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
  const eligibleContacts = eligibleCustomizeRecipientContacts(
    artistContacts,
    contactId,
    suppressedEmails,
  );
  const sendabilityRows = await getOutreachSendabilityBatch(
    eligibleContacts.map((candidate) => ({
      showId,
      contactId: candidate.id,
      singleRecipient: true,
    })),
  );
  const sendabilityByContact = new Map(
    sendabilityRows.map((row) => [row.contactId, row]),
  );
  const retryOutreachIds = sendabilityRows.flatMap((row) =>
    row.mode === "retry" && row.blockingOutreachId
      ? [row.blockingOutreachId]
      : [],
  );
  const retrySnapshots =
    retryOutreachIds.length === 0
      ? []
      : await db.outreach.findMany({
          where: { id: { in: retryOutreachIds } },
          select: {
            id: true,
            contactId: true,
            finalSubject: true,
            finalHtml: true,
            recipientEmails: true,
            recipientSnapshotState: true,
          },
        });
  const retrySnapshotById = new Map(
    retrySnapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  const renderedContentByContact = new Map(
    await Promise.all(
      eligibleContacts.map(async (candidate) => {
        const vars = await buildVarsForShow({
          artistName: contact.artist.name,
          venueName: show.venueName,
          showDate: show.date,
          managerName: candidate.name,
          eventName: show.eventName,
          city: show.city,
          state: show.state,
          countryCode: show.countryCode,
          countryName: show.countryName,
        });
        return [
          candidate.id,
          renderCustomizeRecipientContent(template, vars),
        ] as const;
      }),
    ),
  );
  const recipientOptions: CustomizeRecipientOption[] = eligibleContacts.map(
    (candidate) => {
      const sendability = sendabilityByContact.get(candidate.id);
      const identity = customizeRecipientIdentity(candidate)!;
      const retrySnapshot =
        sendability?.mode === "retry" && sendability.blockingOutreachId
          ? retrySnapshotById.get(sendability.blockingOutreachId)
          : null;
      const validRetrySnapshot =
        retrySnapshot?.contactId === candidate.id &&
        retrySnapshot.recipientSnapshotState === "verified"
          ? retrySnapshot
          : null;
      const retrySelectable =
        sendability?.mode !== "retry" || candidate.id === contactId;
      const content =
        sendability?.mode === "retry"
          ? validRetrySnapshot
            ? {
                subject: validRetrySnapshot.finalSubject,
                html: validRetrySnapshot.finalHtml,
              }
            : null
          : renderedContentByContact.get(candidate.id) ?? null;
      return {
        id: candidate.id,
        artistId: identity.artistId,
        email: identity.normalizedEmail,
        updatedAt: identity.updatedAt,
        label: recipientLabel(candidate),
        eligible: true,
        selectable: retrySelectable,
        sendable:
          sendability?.sendable === true &&
          retrySelectable &&
          content !== null,
        mode: sendability?.mode ?? null,
        reason:
          !retrySelectable
            ? "Open Customize from this contact to retry its immutable outreach."
            : sendability?.mode === "retry" && !validRetrySnapshot
              ? "The immutable retry snapshot is unavailable."
              : sendability?.reason ?? null,
        recipients:
          validRetrySnapshot?.recipientEmails ??
          sendability?.recipients ??
          [],
        isFullTeam: candidate.isFullTeam,
        subject: content?.subject ?? null,
        html: content?.html ?? null,
      };
    },
  );
  if (!recipientOptions.some((option) => option.id === contactId)) {
    const normalizedContextEmail = normalizeEmail(contact.email ?? "");
    recipientOptions.unshift({
      id: contactId,
      artistId: contact.artistId,
      email: normalizedContextEmail ?? contactDisplayValue(contact),
      updatedAt: contact.updatedAt.toISOString(),
      label: `${recipientLabel(contact)} · Unavailable`,
      eligible: false,
      selectable: false,
      sendable: false,
      mode: null,
      reason: normalizedContextEmail
        ? "This recipient address is suppressed."
        : isDirectOutreachOnly(contact)
          ? "This is a direct-outreach contact with no email action."
          : "This contact has no valid email action.",
      recipients: [],
      isFullTeam: contact.isFullTeam,
      subject: null,
      html: null,
    });
  }
  const routeSendability = sendabilityByContact.get(contactId);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Customize &amp; {initialIntent === "queue" ? "queue" : "send"}
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        {contact.artist.name} at {show.venueName},{" "}
        {formatShowDate(show.date, {})}
      </p>
      {hasDirectOutreachNote(contact) && (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <b>Direct outreach:</b> {contact.directOutreachNote}
        </p>
      )}
      <Card className="mt-6">
        <CardBody>
          {trajectoryError ? (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {trajectoryError} Return to recommendations and refresh before
              sending.
            </p>
          ) : (
            <CustomizeForm
              contextContactId={contactId}
              returnTo={safeReturnTo}
              recipientOptions={recipientOptions}
              weekend={isWeekendET()}
              initialIntent={initialIntent}
              queueLabel={formatNextDispatchActionLabel(
                getNextNormalOutreachDispatch(),
              )}
              action={sendCustom.bind(null, {
                showId,
                contextContactId: contactId,
                contextArtistId: contact.artistId,
                returnTo: safeReturnTo,
                retryContactId:
                  routeSendability?.mode === "retry" ? contactId : null,
                trajectoryContext,
              })}
            />
          )}
        </CardBody>
      </Card>
    </main>
  );
}
