import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";
import { applyTemplate, buildVarsForShow, ensureDefaultTemplate } from "@/lib/template";

export const dynamic = "force-dynamic";

async function sendCustom(formData: FormData) {
  "use server";
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const subjectOverride = (formData.get("subject") as string) ?? "";
  const htmlOverride = (formData.get("html") as string) ?? "";
  const result = await sendOutreach({ showId, contactId, subjectOverride, htmlOverride });
  if (result.ok) {
    redirect(`/dashboard?sent=${encodeURIComponent(contactId)}`);
  } else {
    redirect(`/dashboard?error=${encodeURIComponent(result.error ?? "unknown")}`);
  }
}

export default async function CustomizePage({
  params,
}: {
  params: Promise<{ showId: string; contactId: string }>;
}) {
  const { showId, contactId } = await params;
  const [show, contact, template] = await Promise.all([
    db.show.findUnique({ where: { id: showId } }),
    db.contact.findUnique({ where: { id: contactId }, include: { artist: true } }),
    ensureDefaultTemplate(),
  ]);
  if (!show || !contact) return notFound();

  // Pre-fill with composed defaults (uses a placeholder for tracking_tag — real ID is set at send time)
  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    customPrice: contact.customPrice,
    managerName: contact.name,
  });
  const subject = applyTemplate(template.subject, vars);
  const html = applyTemplate(template.htmlBody, vars);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">← Dashboard</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Customize &amp; send</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        To: <b>{contact.name ? `${contact.name} <${contact.email}>` : contact.email}</b><br />
        Show: <b>{contact.artist.name}</b> at {show.venueName}, {show.date.toLocaleDateString()}
      </p>

      <form action={sendCustom} className="mt-6 space-y-4">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="contactId" value={contactId} />
        <div>
          <label htmlFor="subject" className="text-sm font-medium">Subject</label>
          <input
            id="subject"
            name="subject"
            defaultValue={subject}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div>
          <label htmlFor="html" className="text-sm font-medium">HTML body</label>
          <textarea
            id="html"
            name="html"
            rows={20}
            defaultValue={html}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Send now
          </button>
          <Link
            href="/dashboard"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
