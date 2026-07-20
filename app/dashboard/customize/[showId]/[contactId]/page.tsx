import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { workflowReturnPath } from "@/lib/dashboardReturnUrl";
import { getOutreachSendabilityBatch } from "@/lib/sendOutreach";
import { isWeekendET } from "@/lib/schedule";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  ensureDefaultTemplate,
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
  eligibleCustomizeRecipientContacts,
} from "@/lib/customizeRecipients";
import { normalizeEmail, normalizeEmails } from "@/lib/resend";
import {
  CustomizeForm,
  type CustomizeRecipientOption,
} from "./customize-form";
import { sendCustom } from "./actions";

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
  searchParams: Promise<{ returnTo?: SearchParamValue }>;
}) {
  const { showId, contactId } = await params;
  const search = await searchParams;
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const [[show, contact], template] = await Promise.all([
    getCustomizeContext(showId, contactId),
    ensureDefaultTemplate(),
  ]);
  if (!show || !contact) return notFound();

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
  const recipientOptions: CustomizeRecipientOption[] = eligibleContacts.map(
    (candidate) => {
      const sendability = sendabilityByContact.get(candidate.id);
      return {
        id: candidate.id,
        email: normalizeEmail(candidate.email ?? "")!,
        label: recipientLabel(candidate),
        eligible: true,
        sendable: sendability?.sendable === true,
        mode: sendability?.mode ?? null,
        reason: sendability?.reason ?? null,
        recipients: sendability?.recipients ?? [],
        isFullTeam: candidate.isFullTeam,
      };
    },
  );
  if (!recipientOptions.some((option) => option.id === contactId)) {
    const normalizedContextEmail = normalizeEmail(contact.email ?? "");
    recipientOptions.unshift({
      id: contactId,
      email: normalizedContextEmail ?? contactDisplayValue(contact),
      label: `${recipientLabel(contact)} · Unavailable`,
      eligible: false,
      sendable: false,
      mode: null,
      reason: normalizedContextEmail
        ? "This recipient address is suppressed."
        : isDirectOutreachOnly(contact)
          ? "This is a direct-outreach contact with no email action."
          : "This contact has no valid email action.",
      recipients: [],
      isFullTeam: contact.isFullTeam,
    });
  }

  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    managerName: contact.name,
  });
  const subject = applyTemplate(template.subject, vars);
  const html = applyHtmlTemplate(template.htmlBody, vars);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Customize &amp; send</h1>
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
          <CustomizeForm
            contextContactId={contactId}
            returnTo={safeReturnTo}
            initialSubject={subject}
            initialHtml={html}
            recipientOptions={recipientOptions}
            weekend={isWeekendET()}
            action={sendCustom.bind(null, {
              showId,
              contextContactId: contactId,
              returnTo: safeReturnTo,
            })}
          />
        </CardBody>
      </Card>
    </main>
  );
}
