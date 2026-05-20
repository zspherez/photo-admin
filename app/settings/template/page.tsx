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
  let sampleLabel = "Preview: no sample available";
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
      sampleLabel = `Preview: ${matched.artist.name} @ ${sample.venueName}`;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/settings" className="text-sm text-blue-600 hover:underline">← Settings</Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Email template</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Used in: {usedVars.length === 0 ? "no variables" : usedVars.map((v) => (
          <code key={v} className="mx-1 rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">{`{{${v}}}`}</code>
        ))}
      </p>

      <form action={saveTemplate} className="mt-6">
        <TemplateEditor
          initialSubject={template.subject}
          initialHtml={template.htmlBody}
          variables={allVars}
        />
        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Save template
          </button>
        </div>
      </form>

      <form action={resetToDefault} className="mt-2">
        <button
          type="submit"
          className="text-xs text-zinc-500 hover:underline"
        >
          Reset to default
        </button>
      </form>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">{sampleLabel}</h2>
        <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-xs font-medium text-zinc-500">Subject</p>
          <p className="mt-1 font-medium">{previewSubject}</p>
          <p className="mt-4 text-xs font-medium text-zinc-500">Body</p>
          <div
            className="prose prose-sm mt-1 max-w-none rounded border border-zinc-200 p-3 dark:prose-invert dark:border-zinc-800"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </section>
    </main>
  );
}
