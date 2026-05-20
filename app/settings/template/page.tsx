import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_SUBJECT,
  applyTemplate,
  buildVarsForShow,
  ensureDefaultTemplate,
  extractVars,
} from "@/lib/template";
import { TemplateEditor } from "@/components/template-editor";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const KNOWN_VARS = ["artist", "venue", "date", "rate", "portfolio_url", "manager_name"];

async function saveTemplate(formData: FormData) {
  "use server";
  const subject = (formData.get("subject") as string)?.trim() ?? "";
  const htmlBody = (formData.get("html") as string) ?? "";
  if (!subject || !htmlBody) return;
  const existing = await db.emailTemplate.findFirst({ where: { isDefault: true } });
  if (existing) {
    await db.emailTemplate.update({
      where: { id: existing.id },
      data: { subject, htmlBody },
    });
  } else {
    await db.emailTemplate.create({
      data: { name: DEFAULT_TEMPLATE_NAME, subject, htmlBody, isDefault: true },
    });
  }
  revalidatePath("/settings/template");
  revalidatePath("/");
}

async function resetToDefault() {
  "use server";
  const existing = await db.emailTemplate.findFirst({ where: { isDefault: true } });
  if (existing) {
    await db.emailTemplate.update({
      where: { id: existing.id },
      data: { subject: DEFAULT_TEMPLATE_SUBJECT, htmlBody: DEFAULT_TEMPLATE_HTML },
    });
  }
  revalidatePath("/settings/template");
}

export default async function TemplateSettingsPage() {
  const template = await ensureDefaultTemplate();
  const usedVars = extractVars(template.subject + " " + template.htmlBody);
  const allVars = Array.from(new Set([...KNOWN_VARS, ...usedVars])).sort();

  const sample = await db.show.findFirst({
    where: {
      date: { gte: new Date() },
      artists: {
        some: {
          artist: { contacts: { some: {} }, listenSignals: { some: {} } },
        },
      },
    },
    include: { artists: { include: { artist: { include: { contacts: true } } } } },
    orderBy: { date: "asc" },
  });

  let previewSubject = template.subject;
  let previewHtml = template.htmlBody;
  let sampleLabel = "No sample available";
  if (sample) {
    const matched = sample.artists.find((sa) => sa.artist.contacts.length > 0);
    if (matched) {
      const contact = matched.artist.contacts[0];
      const sampleVars = await buildVarsForShow({
        artistName: matched.artist.name,
        venueName: sample.venueName,
        showDate: sample.date,
        customPrice: contact.customPrice,
        managerName: contact.name,
      });
      previewSubject = applyTemplate(template.subject, sampleVars);
      previewHtml = applyTemplate(template.htmlBody, sampleVars);
      sampleLabel = `Preview: ${matched.artist.name} at ${sample.venueName}`;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Email template</h1>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500">Used variables:</span>
        {usedVars.length === 0 ? (
          <span className="text-xs text-zinc-400">none</span>
        ) : (
          usedVars.map((v) => <Badge key={v} tone="muted" size="xs">{`{{${v}}}`}</Badge>)
        )}
      </div>

      <Card className="mt-6">
        <CardBody>
          <form action={saveTemplate}>
            <TemplateEditor
              initialSubject={template.subject}
              initialHtml={template.htmlBody}
              variables={allVars}
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <Button type="submit" variant="primary">Save template</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <form action={resetToDefault} className="mt-3">
        <button type="submit" className="text-xs text-zinc-500 hover:underline">
          Reset to default
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{sampleLabel}</h2>
        <Card className="mt-3">
          <CardBody>
            <p className="text-xs font-medium text-zinc-500">Subject</p>
            <p className="mt-1 font-medium">{previewSubject}</p>
            <p className="mt-4 text-xs font-medium text-zinc-500">Body</p>
            <div
              className="prose prose-sm mt-1 max-w-none rounded-md border border-zinc-100 bg-zinc-50/40 p-3 dark:prose-invert dark:border-zinc-900 dark:bg-zinc-900/40"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </CardBody>
        </Card>
      </section>
    </main>
  );
}
