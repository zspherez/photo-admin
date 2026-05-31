import { db } from "@/lib/db";
import { applyTemplate, buildVarsForShow, ensureDefaultTemplate } from "@/lib/template";
import { getTestOverride, sendEmailViaResend } from "@/lib/resend";

export interface SendOutreachInput {
  showId: string;
  contactId: string;
  subjectOverride?: string;
  htmlOverride?: string;
}

export interface SendOutreachOutput {
  ok: boolean;
  outreachId?: string;
  error?: string;
  scheduled?: boolean;
  scheduledFor?: Date;
}

// Shared helper: resolve recipients, check duplicates, render email content.
async function prepareOutreach(input: SendOutreachInput) {
  const { showId, contactId, subjectOverride, htmlOverride } = input;
  const [show, contact, template] = await Promise.all([
    db.show.findUnique({
      where: { id: showId },
      include: { artists: { include: { artist: true } } },
    }),
    db.contact.findUnique({ where: { id: contactId }, include: { artist: true } }),
    ensureDefaultTemplate(),
  ]);
  if (!show) return { error: "Show not found" } as const;
  if (!contact) return { error: "Contact not found" } as const;

  const siblingContacts = await db.contact.findMany({
    where: { artistId: contact.artistId },
  });
  const siblingIds = siblingContacts.map((c) => c.id);
  const recipients = Array.from(
    new Set(
      siblingContacts
        .map((c) => c.email)
        .filter((e): e is string => !!e && e.includes("@"))
    )
  );
  if (recipients.length === 0) {
    return { error: "No valid emails for this artist" } as const;
  }

  // Block if already sent or scheduled for this artist + show
  const alreadyExists = await db.outreach.findFirst({
    where: { showId, contactId: { in: siblingIds }, status: { in: ["sent", "scheduled"] } },
  });
  if (alreadyExists) {
    const label = alreadyExists.status === "scheduled" ? "Already scheduled" : "Already sent";
    return { error: `${label} for this artist on this show`, outreachId: alreadyExists.id } as const;
  }

  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    customPrice: contact.customPrice,
    managerName: contact.name,
  });

  const subject = subjectOverride?.trim() || applyTemplate(template.subject, vars);
  const html = htmlOverride?.trim() || applyTemplate(template.htmlBody, vars);

  return { show, contact, template, recipients, siblingIds, subject, html } as const;
}

export async function sendOutreach(input: SendOutreachInput): Promise<SendOutreachOutput> {
  const prep = await prepareOutreach(input);
  if ("error" in prep) {
    return { ok: false, error: prep.error, outreachId: "outreachId" in prep ? prep.outreachId : undefined };
  }
  const { show, contact, template, recipients, subject, html } = prep;

  const existing = await db.outreach.findUnique({
    where: { showId_contactId: { showId: input.showId, contactId: input.contactId } },
  });
  const outreach = existing
    ? await db.outreach.update({
        where: { id: existing.id },
        data: { status: "queued", error: null, finalSubject: "", finalHtml: "", scheduledFor: null },
      })
    : await db.outreach.create({
        data: {
          showId: input.showId,
          artistId: contact.artistId,
          contactId: input.contactId,
          templateId: template.id,
          finalSubject: "",
          finalHtml: "",
          status: "queued",
        },
      });

  const result = await sendEmailViaResend({
    to: recipients,
    subject,
    html,
    outreachId: outreach.id,
  });

  const isTestSend = !!(await getTestOverride());
  await db.outreach.update({
    where: { id: outreach.id },
    data: {
      finalSubject: subject,
      finalHtml: html,
      status: result.error ? "failed" : isTestSend ? "test" : "sent",
      error: result.error,
      providerMessageId: result.providerMessageId,
      sentAt: result.error ? null : new Date(),
    },
  });

  return result.error
    ? { ok: false, error: result.error, outreachId: outreach.id }
    : { ok: true, outreachId: outreach.id };
}

/**
 * Schedule an outreach for a future time instead of sending immediately.
 * Renders subject/html now and stores them with the scheduled row.
 */
export async function scheduleOutreach(
  input: SendOutreachInput,
  scheduledFor: Date
): Promise<SendOutreachOutput> {
  const prep = await prepareOutreach(input);
  if ("error" in prep) {
    return { ok: false, error: prep.error, outreachId: "outreachId" in prep ? prep.outreachId : undefined };
  }
  const { contact, template, subject, html } = prep;

  const existing = await db.outreach.findUnique({
    where: { showId_contactId: { showId: input.showId, contactId: input.contactId } },
  });
  const outreach = existing
    ? await db.outreach.update({
        where: { id: existing.id },
        data: {
          status: "scheduled",
          error: null,
          finalSubject: subject,
          finalHtml: html,
          scheduledFor,
          sentAt: null,
          providerMessageId: null,
        },
      })
    : await db.outreach.create({
        data: {
          showId: input.showId,
          artistId: contact.artistId,
          contactId: input.contactId,
          templateId: template.id,
          finalSubject: subject,
          finalHtml: html,
          status: "scheduled",
          scheduledFor,
        },
      });

  return { ok: true, outreachId: outreach.id, scheduled: true, scheduledFor };
}

/**
 * Dispatch a previously scheduled outreach row. Used by the cron job.
 * Atomically claims the row (scheduled → queued) to prevent double-sends.
 */
export async function dispatchScheduledOutreach(outreachId: string): Promise<SendOutreachOutput> {
  // Atomic claim: only proceed if status is still "scheduled"
  const claimed = await db.outreach.updateMany({
    where: { id: outreachId, status: "scheduled" },
    data: { status: "queued" },
  });
  if (claimed.count === 0) {
    return { ok: false, error: "Already claimed or cancelled" };
  }

  const outreach = await db.outreach.findUnique({
    where: { id: outreachId },
    include: { contact: { include: { artist: true } } },
  });
  if (!outreach || !outreach.contactId || !outreach.contact) {
    return { ok: false, error: "Outreach or contact not found", outreachId };
  }

  // Resolve current recipients (contacts may have changed since scheduling)
  const siblingContacts = await db.contact.findMany({
    where: { artistId: outreach.contact.artistId },
  });
  const recipients = Array.from(
    new Set(
      siblingContacts
        .map((c) => c.email)
        .filter((e): e is string => !!e && e.includes("@"))
    )
  );
  if (recipients.length === 0) {
    await db.outreach.update({
      where: { id: outreachId },
      data: { status: "failed", error: "No valid emails at dispatch time" },
    });
    return { ok: false, error: "No valid emails at dispatch time", outreachId };
  }

  const result = await sendEmailViaResend({
    to: recipients,
    subject: outreach.finalSubject,
    html: outreach.finalHtml,
    outreachId,
  });

  const isTestSend = !!(await getTestOverride());
  await db.outreach.update({
    where: { id: outreachId },
    data: {
      status: result.error ? "failed" : isTestSend ? "test" : "sent",
      error: result.error,
      providerMessageId: result.providerMessageId,
      sentAt: result.error ? null : new Date(),
      scheduledFor: null,
    },
  });

  return result.error
    ? { ok: false, error: result.error, outreachId }
    : { ok: true, outreachId };
}
