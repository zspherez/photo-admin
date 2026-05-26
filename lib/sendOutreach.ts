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
}

export async function sendOutreach({
  showId,
  contactId,
  subjectOverride,
  htmlOverride,
}: SendOutreachInput): Promise<SendOutreachOutput> {
  const [show, contact, template] = await Promise.all([
    db.show.findUnique({
      where: { id: showId },
      include: { artists: { include: { artist: true } } },
    }),
    db.contact.findUnique({ where: { id: contactId }, include: { artist: true } }),
    ensureDefaultTemplate(),
  ]);
  if (!show) return { ok: false, error: "Show not found" };
  if (!contact) return { ok: false, error: "Contact not found" };

  // Find every contact for the same artist — we send a single email to all of
  // them so they're on the same thread. The clicked contact (contactId) is
  // the "primary" used for the Outreach row + greeting.
  const siblingContacts = await db.contact.findMany({
    where: { artistId: contact.artistId },
  });
  const siblingIds = siblingContacts.map((c) => c.id);
  const recipients = Array.from(
    new Set(siblingContacts.map((c) => c.email).filter((e) => e && e.includes("@")))
  );
  if (recipients.length === 0) {
    return { ok: false, error: "No valid emails for this artist" };
  }

  // Block re-send if ANY contact for this artist already has a sent outreach
  // for this show.
  const alreadySent = await db.outreach.findFirst({
    where: { showId, contactId: { in: siblingIds }, status: "sent" },
  });
  if (alreadySent) {
    return { ok: false, error: "Already sent for this artist on this show", outreachId: alreadySent.id };
  }

  const existing = await db.outreach.findUnique({
    where: { showId_contactId: { showId, contactId } },
  });
  const outreach = existing
    ? await db.outreach.update({
        where: { id: existing.id },
        data: { status: "queued", error: null, finalSubject: "", finalHtml: "" },
      })
    : await db.outreach.create({
        data: {
          showId,
          artistId: contact.artistId,
          contactId,
          templateId: template.id,
          finalSubject: "",
          finalHtml: "",
          status: "queued",
        },
      });

  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    customPrice: contact.customPrice,
    managerName: contact.name,
  });

  const subject = subjectOverride?.trim() || applyTemplate(template.subject, vars);
  const html = htmlOverride?.trim() || applyTemplate(template.htmlBody, vars);

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
