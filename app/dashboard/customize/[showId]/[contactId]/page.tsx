import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { sendOutreach } from "@/lib/sendOutreach";
import { applyTemplate, buildVarsForShow, ensureDefaultTemplate } from "@/lib/template";
import { Card, CardBody } from "@/components/ui/card";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";

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
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Dashboard</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Customize &amp; send</h1>
      <p className="mt-1 text-sm text-zinc-500">
        To <b>{contact.name ? `${contact.name} <${contact.email}>` : contact.email}</b> · {contact.artist.name} at {show.venueName}, {show.date.toLocaleDateString()}
      </p>

      <Card className="mt-6">
        <CardBody>
          <form action={sendCustom} className="space-y-4">
            <input type="hidden" name="showId" value={showId} />
            <input type="hidden" name="contactId" value={contactId} />
            <Field name="subject" label="Subject" defaultValue={subject} />
            <TextArea name="html" label="HTML body" rows={20} defaultValue={html} mono />
            <div className="flex gap-2">
              <Button type="submit" variant="primary">Send now</Button>
              <LinkButton href="/dashboard" variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
