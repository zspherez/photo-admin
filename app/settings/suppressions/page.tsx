import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSessionAccess, requireServerActionAuth, SESSION_COOKIE } from "@/lib/auth";
import { artistDisplayName } from "@/lib/artistDisplayName";
import { normalizeEmail } from "@/lib/resend";
import { appConfig } from "@/lib/appConfig";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { releaseEmailSuppression, suppressionReleaseInput } from "@/lib/suppressionRelease";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email suppressions" };
const PATH = "/settings/suppressions";

async function unsuppress(formData: FormData) {
  "use server";
  await requireServerActionAuth(PATH);
  const input = suppressionReleaseInput(formData);
  if ("error" in input) {
    redirect(`${PATH}?error=${encodeURIComponent(input.error)}`);
  }
  const result = await releaseEmailSuppression(input);
  if ("error" in result) {
    redirect(`${PATH}?error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath("/", "layout");
  redirect(`${PATH}?released=${encodeURIComponent(input.email)}`);
}

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: SearchParamValue; error?: SearchParamValue; released?: SearchParamValue }>;
}) {
  const params = await searchParams;
  const search = (firstSearchParam(params.search) ?? "").trim().slice(0, 200);
  const access = await getSessionAccess((await cookies()).get(SESSION_COOKIE)?.value);
  const matchedContacts = search ? await db.contact.findMany({
    where: {
      email: { not: null },
      ...(search ? {
        OR: [
          { email: { contains: search, mode: "insensitive" as const } },
          { artist: { name: { contains: search, mode: "insensitive" as const } } },
          { artist: { customName: { contains: search, mode: "insensitive" as const } } },
        ],
      } : {}),
    },
    select: { email: true },
  }) : [];
  const matchedEmails = [...new Set(matchedContacts.flatMap((c) => {
    const email = normalizeEmail(c.email ?? "");
    return email ? [email] : [];
  }))];
  const suppressions = await db.emailSuppression.findMany({
    where: search ? { OR: [
      { normalizedEmail: { contains: search, mode: "insensitive" } },
      { normalizedEmail: { in: matchedEmails } },
    ] } : {},
    orderBy: [{ suppressedAt: "desc" }, { normalizedEmail: "asc" }],
    take: 101,
  });
  const contacts = suppressions.length ? await db.contact.findMany({
    where: { OR: suppressions.slice(0, 100).map((row) => ({
      email: { equals: row.normalizedEmail, mode: "insensitive" as const },
    })) },
    select: { email: true, artist: { select: { id: true, name: true, customName: true } } },
  }) : [];
  const releases = await db.emailSuppressionRelease.findMany({
    where: search ? { OR: [
      { normalizedEmail: { contains: search, mode: "insensitive" } },
      { normalizedEmail: { in: matchedEmails } },
    ] } : {},
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const displayTime = (date: Date) => date.toLocaleString("en-US", {
    timeZone: appConfig.timeZone, dateStyle: "medium", timeStyle: "short",
  });
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/settings" className="text-sm underline">Back to settings</Link>
      <h1 className="mt-4 text-2xl font-semibold">Email suppressions</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Search by artist or address. Unblocking removes this app&apos;s address-wide suppression for every artist using it.
        It does not resend emails, change contacts, reset failed outreach, or remove provider-side blocks.
        A new bounce or complaint can suppress the address again.
      </p>
      {firstSearchParam(params.error) && <p role="alert" className="mt-4 text-red-600">{firstSearchParam(params.error)}</p>}
      {firstSearchParam(params.released) && <p role="status" className="mt-4 text-green-700">App suppression removed for {firstSearchParam(params.released)}. No email was sent.</p>}
      <form className="my-6 flex gap-2">
        <input aria-label="Artist or email" name="search" defaultValue={search} maxLength={200} className="min-w-0 flex-1 rounded border p-2" />
        <button className="rounded border px-4" type="submit">Search</button>
      </form>
      {suppressions.length === 0 && <p>No suppressed addresses match.</p>}
      {suppressions.length > 100 && <p>Showing the first 100. Narrow your search to see more.</p>}
      <ul className="space-y-4">
        {suppressions.slice(0, 100).map((row) => {
          const artists = [...new Map(contacts.filter((c) => normalizeEmail(c.email ?? "") === row.normalizedEmail).map((c) => [c.artist.id, c.artist])).values()];
          return <li key={row.normalizedEmail} className="rounded border p-4">
            <h2 className="break-all font-semibold">{row.normalizedEmail}</h2>
            <p className="text-sm">{artists.map(artistDisplayName).join(", ") || "No matching artist contact"}</p>
            <p className="mt-2 text-sm">Reason: {row.reason} · Source: {row.source}</p>
            <p className="text-sm">Suppressed {displayTime(row.suppressedAt)} ({appConfig.timeZone})</p>
            {row.sourceEventId && <p className="break-all text-xs text-zinc-500">Event: {row.sourceEventId}</p>}
            <form action={unsuppress} className="mt-3 space-y-3">
              <input type="hidden" name="email" value={row.normalizedEmail} />
              <input type="hidden" name="version" value={row.updatedAt.toISOString()} />
              <label className="block text-sm">Review note
                <input name="note" required maxLength={1000} disabled={access !== "admin"} className="mt-1 block w-full rounded border p-2" />
              </label>
              <label className="block text-sm">
                <input type="checkbox" name="confirmed" value="yes" required disabled={access !== "admin"} className="mr-2" />
                I reviewed the reason and authorize unblocking this address for all artists using it.
              </label>
              <PendingSubmitButton disabled={access !== "admin"} pendingLabel="Unblocking...">Unblock address</PendingSubmitButton>
            </form>
          </li>;
        })}
      </ul>
      {access !== "admin" && <p className="mt-4">Sign in as an admin to unblock addresses.</p>}
      <h2 className="mt-8 text-lg font-semibold">Recent unblock history</h2>
      <ul className="mt-3 space-y-3">
        {releases.map((row) => <li key={row.id} className="rounded border p-3 text-sm">
          <p>{row.normalizedEmail} · {displayTime(row.createdAt)} ({appConfig.timeZone})</p>
          <p>Previous reason: {row.reason}</p><p>Review note: {row.note}</p>
        </li>)}
      </ul>
    </main>
  );
}
