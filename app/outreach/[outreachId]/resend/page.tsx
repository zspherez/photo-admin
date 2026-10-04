import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionAccess, requireServerActionAuth, SESSION_COOKIE } from "@/lib/auth";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeEmails } from "@/lib/resend";
import {
  dispatchReviewedPartitionedBounceResend,
  prepareReviewedPartitionedBounceResend,
  resetBouncedOutreachForResend,
} from "@/lib/sendOutreach";
import { getNextMondaySlot, getNextNormalOutreachDispatch, isWeekendET } from "@/lib/schedule";
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
    select: { showId: true, kind: true, parentOutreachId: true, festivalRecipientPartition: true },
  });
  if (!outreach) notFound();
  const result = await resetBouncedOutreachForResend(outreachId, contactId, {
    expectedIdempotencyKey,
    allowReleasedRecipients: true,
  });
  if (!result.ok) redirect(`${path}?error=${encodeURIComponent(result.error)}`);
  refreshWorkflowViews("/outreach", [`/festivals/${outreach.showId}`]);
  if (outreach.festivalRecipientPartition) {
    const prepared = await db.outreach.findUnique({
      where: { id: outreachId },
      select: { idempotencyKey: true },
    });
    if (!prepared) notFound();
    redirect(`${path}?prepared=${encodeURIComponent(prepared.idempotencyKey)}`);
  }
  const query = new URLSearchParams({ returnTo: "/outreach" });
  if (outreach.kind === "follow_up" && outreach.parentOutreachId) {
    query.set("parentOutreachId", outreach.parentOutreachId);
  }
  redirect(`/dashboard/customize/${encodeURIComponent(outreach.showId)}/${encodeURIComponent(contactId)}?${query}`);
}

async function sendReviewedResend(formData: FormData) {
    "use server";
    await requireServerActionAuth("/outreach");
    const outreachId = String(formData.get("outreachId") ?? "");
    const attemptKey = String(formData.get("attemptKey") ?? "");
    const previewHash = String(formData.get("previewHash") ?? "");
    const intent = String(formData.get("intent") ?? "");
    if (!outreachId || !attemptKey || !previewHash || formData.get("confirmed") !== "yes" ||
        (intent !== "send" && intent !== "queue")) {
      throw new Error("Review and confirm the partitioned resend before submitting.");
    }
    const path = `/outreach/${encodeURIComponent(outreachId)}/resend`;
    const row = await db.outreach.findUnique({
      where: { id: outreachId },
      select: { showId: true, festivalRecipientPartition: true },
    });
    if (!row?.festivalRecipientPartition) notFound();
    const scheduledFor = intent === "queue"
      ? getNextNormalOutreachDispatch()
      : isWeekendET() ? getNextMondaySlot() : undefined;
    const result = await dispatchReviewedPartitionedBounceResend(
      outreachId, attemptKey, previewHash, scheduledFor,
    );
    if (!result.ok) {
      redirect(`${path}?prepared=${encodeURIComponent(attemptKey)}&error=${encodeURIComponent(result.error ?? "Resend failed")}`);
    }
    refreshWorkflowViews("/outreach", [`/festivals/${row.showId}`]);
    redirect(`/festivals/${encodeURIComponent(row.showId)}?${result.scheduled ? "scheduled" : "sent"}=1`);
}

export default async function BouncedResendPage({
  params, searchParams,
}: {
  params: Promise<{ outreachId: string }>;
  searchParams: Promise<{ error?: SearchParamValue; prepared?: SearchParamValue }>;
}) {
  const { outreachId } = await params;
  const search = await searchParams;
  const row = await db.outreach.findUnique({
    where: { id: outreachId },
    select: {
      id: true, artistId: true, contactId: true, kind: true, status: true,
      festivalRecipientPartition: true, idempotencyKey: true,
      bouncedAt: true, error: true, recipientEmails: true,
      finalSubject: true, artist: { select: { name: true, customName: true } },
      show: { select: { eventName: true, venueName: true } },
      coveredArtists: { select: { artist: { select: { name: true, customName: true } } } },
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
  const preparedKey = firstSearchParam(search.prepared);
  const reviewed = row.festivalRecipientPartition && preparedKey
    ? await prepareReviewedPartitionedBounceResend(row.id, preparedKey)
    : null;
  const partitionChoices = row.festivalRecipientPartition
    ? choices.filter((choice) =>
        choice.id === row.contactId &&
        normalizeEmails([choice.email ?? ""])[0] === normalizeEmails(row.recipientEmails)[0],
      )
    : choices;
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/outreach" className="text-sm underline">Back to outreach</Link>
      <h1 className="mt-4 text-2xl font-semibold">Review bounced outreach</h1>
      <p className="mt-2">{artistDisplayName(row.artist)} · {row.show.eventName || row.show.venueName}</p>
      <p className="mt-2 text-sm">Subject: {row.finalSubject}</p>
      <p className="break-all text-sm">Previous recipients: {row.recipientEmails.join(", ")}</p>
      {row.error && <p className="mt-2 text-sm text-red-600">{row.error}</p>}
      <p className="mt-4 text-sm">
        {row.festivalRecipientPartition
          ? "Explicitly unblock the original address in settings first. Reusing a bounced address requires a recorded unblock after this bounce. Provider-side blocks may still prevent delivery."
          : "Correct the bounced contact, or explicitly unblock its address in settings first. Reusing a bounced address requires a recorded unblock after this bounce. Provider-side blocks may still prevent delivery."}
      </p>
      {row.festivalRecipientPartition && (
        <p className="mt-2 text-sm">
          Partitioned resend is limited to the original contact and address shared by all originally covered artists.
          Corrected addresses cannot be substituted here: they require a separately reviewed migration of immutable
          recipient and artist coverage. Unblock the original address after the bounce to retry it.
        </p>
      )}
      <div className="my-3 flex gap-4 text-sm underline">
        <Link href={`/artists/${row.artistId}`}>Edit artist contacts</Link>
        <Link href={`/settings/suppressions?search=${encodeURIComponent(artistDisplayName(row.artist))}`}>Review suppressions</Link>
      </div>
      <p className="text-sm">
        {row.festivalRecipientPartition
          ? "This preserves the previous attempt and webhook history. Nothing is sent until you review the exact recipient, artist scope and generated content here and choose Send or Schedule."
          : "This prepares a fresh send and keeps previous attempts and webhook history. Nothing is sent until you review the recipients and content in Customize and choose Send or Schedule. Grouped emails may include recipients who received the previous attempt."}
      </p>
      {firstSearchParam(search.error) && <p role="alert" className="mt-4 text-red-600">{firstSearchParam(search.error)}</p>}
      {reviewed?.ok && (
        <form action={sendReviewedResend} className="mt-5 space-y-4">
          <h2 className="text-lg font-semibold">Review the exact partitioned send</h2>
          <p>Scope: {reviewed.preview.kind === "follow_up" ? "follow-up" : "original"} · {row.coveredArtists.length
            ? row.coveredArtists.map(({ artist }) => artistDisplayName(artist)).join(", ")
            : artistDisplayName(row.artist)}</p>
          <p>To: {reviewed.preview.recipients.join(", ")}</p>
          <p>Delivery mode: {reviewed.preview.recipientDeliveryMode}</p>
          <p>Subject: {reviewed.preview.subject}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-3 text-xs">{reviewed.preview.html}</pre>
          <input type="hidden" name="outreachId" value={row.id} />
          <input type="hidden" name="attemptKey" value={preparedKey} />
          <input type="hidden" name="previewHash" value={reviewed.previewHash} />
          <label className="block text-sm">
            <input type="checkbox" required name="confirmed" value="yes" disabled={access !== "admin"} className="mr-2" />
            I reviewed this recipient, artist scope, and content.
          </label>
          <PendingSubmitButton name="intent" value="send" disabled={access !== "admin"} pendingLabel="Submitting...">Send (or schedule for Monday)</PendingSubmitButton>
          <PendingSubmitButton name="intent" value="queue" disabled={access !== "admin"} pendingLabel="Scheduling...">Schedule next dispatch</PendingSubmitButton>
        </form>
      )}
      {reviewed && !reviewed.ok && <p role="alert" className="mt-4 text-red-600">{reviewed.error}</p>}
      {!bounced && !reviewed?.ok ? <p className="mt-4">This outreach is no longer a failed bounced email.</p> : bounced ? (
        <form action={prepareResend} className="mt-5 space-y-4">
          <input type="hidden" name="outreachId" value={row.id} />
          <input type="hidden" name="attemptKey" value={row.idempotencyKey} />
          <label className="block text-sm">Contact for resend
            <select name="contactId" required disabled={access !== "admin" || !partitionChoices.length}
              defaultValue={partitionChoices.find((c) => c.id === row.contactId)?.id ?? partitionChoices[0]?.id}
              className="mt-1 block w-full rounded border p-2">
              {partitionChoices.map((contact) => <option key={contact.id} value={contact.id}>{contact.email}{contact.name ? ` · ${contact.name}` : ""}</option>)}
            </select>
          </label>
          {!partitionChoices.length && <p>{row.festivalRecipientPartition ? "No eligible unsuppressed original address is available. Review suppressions first." : "No unsuppressed active email is available. Correct the contact or review suppressions first."}</p>}
          <label className="block text-sm">
            <input type="checkbox" required name="confirmed" value="yes" disabled={access !== "admin"} className="mr-2" />
            I reviewed the bounce and authorize preparing a new send.
          </label>
          <PendingSubmitButton disabled={access !== "admin" || !partitionChoices.length} pendingLabel="Preparing...">{row.festivalRecipientPartition ? "Prepare resend & review" : "Prepare resend & customize"}</PendingSubmitButton>
        </form>
      ) : null}
      {access !== "admin" && <p className="mt-4 text-sm">Sign in as admin to prepare a resend.</p>}
    </main>
  );
}
