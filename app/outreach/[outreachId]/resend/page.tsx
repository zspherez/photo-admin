import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionAccess, requireServerActionAuth, SESSION_COOKIE } from "@/lib/auth";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeEmails } from "@/lib/resend";
import { resetBouncedOutreachForResend } from "@/lib/sendOutreach";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review bounced outreach" };

async function prepareResend(formData: FormData) {
  "use server";
  await requireServerActionAuth("/outreach");
  const outreachId = String(formData.get("outreachId") ?? "");
  const contactId = String(formData.get("contactId") ?? "");
  const expectedIdempotencyKey = String(formData.get("attemptKey") ?? "");
  if (!outreachId || !contactId || !expectedIdempotencyKey || formData.get("confirmed") !== "yes") {
    throw new Error("Select a contact and confirm the bounced resend review.");
  }
  const path = `/outreach/${encodeURIComponent(outreachId)}/resend`;
  const outreach = await db.outreach.findUnique({
    where: { id: outreachId },
    select: { showId: true, kind: true, parentOutreachId: true },
  });
  if (!outreach) notFound();
  const result = await resetBouncedOutreachForResend(outreachId, contactId, {
    expectedIdempotencyKey,
    allowReleasedRecipients: true,
  });
  if (!result.ok) redirect(`${path}?error=${encodeURIComponent(result.error)}`);
  refreshWorkflowViews("/outreach", [`/festivals/${outreach.showId}`]);
  const query = new URLSearchParams({ returnTo: "/outreach" });
  if (outreach.kind === "follow_up" && outreach.parentOutreachId) {
    query.set("parentOutreachId", outreach.parentOutreachId);
  }
  redirect(`/dashboard/customize/${encodeURIComponent(outreach.showId)}/${encodeURIComponent(contactId)}?${query}`);
}

export default async function BouncedResendPage({
  params, searchParams,
}: {
  params: Promise<{ outreachId: string }>;
  searchParams: Promise<{ error?: SearchParamValue }>;
}) {
  const { outreachId } = await params;
  const search = await searchParams;
  const row = await db.outreach.findUnique({
    where: { id: outreachId },
    select: {
      id: true, artistId: true, contactId: true, kind: true, status: true,
      bouncedAt: true, idempotencyKey: true, error: true, recipientEmails: true,
      finalSubject: true, artist: { select: { name: true, customName: true } },
      show: { select: { eventName: true, venueName: true } },
    },
  });
  if (!row) notFound();
  const contacts = await db.contact.findMany({
    where: { artistId: row.artistId, state: "active", email: { not: null } },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: { id: true, email: true, name: true },
  });
  const addresses = normalizeEmails(contacts.map((contact) => contact.email ?? ""));
  const blocked = new Set((await db.emailSuppression.findMany({
    where: { normalizedEmail: { in: addresses } },
    select: { normalizedEmail: true },
  })).map((suppression) => suppression.normalizedEmail));
  const choices = contacts.filter((contact) => {
    const email = normalizeEmails([contact.email ?? ""])[0];
    return email && !blocked.has(email);
  });
  const access = await getSessionAccess((await cookies()).get(SESSION_COOKIE)?.value);
  const bounced = row.status === "failed" && row.bouncedAt !== null;
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/outreach" className="text-sm underline">Back to outreach</Link>
      <h1 className="mt-4 text-2xl font-semibold">Review bounced outreach</h1>
      <p className="mt-2">{artistDisplayName(row.artist)} · {row.show.eventName || row.show.venueName}</p>
      <p className="mt-2 text-sm">Subject: {row.finalSubject}</p>
      <p className="break-all text-sm">Previous recipients: {row.recipientEmails.join(", ")}</p>
      {row.error && <p className="mt-2 text-sm text-red-600">{row.error}</p>}
      <p className="mt-4 text-sm">
        Correct the bounced contact, or explicitly unblock its address in settings first.
        Reusing a bounced address requires a recorded unblock after this bounce.
        Provider-side blocks may still prevent delivery.
      </p>
      <div className="my-3 flex gap-4 text-sm underline">
        <Link href={`/artists/${row.artistId}`}>Edit artist contacts</Link>
        <Link href={`/settings/suppressions?search=${encodeURIComponent(artistDisplayName(row.artist))}`}>Review suppressions</Link>
      </div>
      <p className="text-sm">
        This prepares a fresh send and keeps previous attempts and webhook history.
        Nothing is sent until you review the recipients and content in Customize and choose Send or Schedule.
        Grouped emails may include recipients who received the previous attempt.
      </p>
      {firstSearchParam(search.error) && <p role="alert" className="mt-4 text-red-600">{firstSearchParam(search.error)}</p>}
      {!bounced ? <p className="mt-4">This outreach is no longer a failed bounced email.</p> : (
        <form action={prepareResend} className="mt-5 space-y-4">
          <input type="hidden" name="outreachId" value={row.id} />
          <input type="hidden" name="attemptKey" value={row.idempotencyKey} />
          <label className="block text-sm">Contact for resend
            <select name="contactId" required disabled={access !== "admin" || !choices.length}
              defaultValue={choices.find((c) => c.id === row.contactId)?.id ?? choices[0]?.id}
              className="mt-1 block w-full rounded border p-2">
              {choices.map((contact) => <option key={contact.id} value={contact.id}>{contact.email}{contact.name ? ` · ${contact.name}` : ""}</option>)}
            </select>
          </label>
          {!choices.length && <p>No unsuppressed active email is available. Correct the contact or review suppressions first.</p>}
          <label className="block text-sm">
            <input type="checkbox" required name="confirmed" value="yes" disabled={access !== "admin"} className="mr-2" />
            I reviewed the bounce and authorize preparing a new send.
          </label>
          <PendingSubmitButton disabled={access !== "admin" || !choices.length} pendingLabel="Preparing...">Prepare resend &amp; customize</PendingSubmitButton>
        </form>
      )}
      {access !== "admin" && <p className="mt-4 text-sm">Sign in as admin to prepare a resend.</p>}
    </main>
  );
}
