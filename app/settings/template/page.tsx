import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_SUBJECT,
  applyTemplate,
  buildVarsForShow,
  cloneTemplateContent,
  ensureDefaultTemplate,
  ensureFollowUpTemplate,
  extractVars,
} from "@/lib/template";
import { renderTrackedEmailHtml } from "@/lib/emailUtm";
import { readEmailUtmSettingsSnapshot } from "@/lib/generalSettings";
import { TemplateEditor } from "@/components/template-editor";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { pickEmailContact } from "@/lib/contactSelection";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { requireServerActionAuth } from "@/lib/auth";
import {
  firstSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email template" };

const KNOWN_VARS = [
  "artist",
  "venue",
  "date",
  "rate",
  "portfolio_url",
  "sender_name",
  "sender_email",
  "sender_phone",
  "sender_city",
  "manager_name",
];

type TemplateKind = "original" | "follow_up";

function parseTemplateKind(value: unknown): TemplateKind {
  return firstSearchParam(value) === "follow_up" ? "follow_up" : "original";
}

function requiredTemplateKind(value: FormDataEntryValue | null): TemplateKind {
  if (value === "original" || value === "follow_up") return value;
  throw new Error("Invalid email template kind");
}

function templateSettingsPath(kind: TemplateKind): string {
  return kind === "follow_up"
    ? "/settings/template?kind=follow_up"
    : "/settings/template";
}

async function ensureTemplate(kind: TemplateKind) {
  return kind === "follow_up"
    ? ensureFollowUpTemplate()
    : ensureDefaultTemplate();
}

async function saveTemplate(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/template");
  const kind = requiredTemplateKind(formData.get("kind"));
  const subject = (formData.get("subject") as string)?.trim() ?? "";
  const htmlBody = (formData.get("html") as string) ?? "";
  if (!subject || !htmlBody) return;
  const existing = await ensureTemplate(kind);
  await db.emailTemplate.update({
    where: { id: existing.id },
    data: { subject, htmlBody },
  });
  revalidatePath("/settings/template");
  revalidatePath("/");
}

async function resetToDefault(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/template");
  const kind = requiredTemplateKind(formData.get("kind"));
  const existing = await ensureTemplate(kind);
  const content =
    kind === "follow_up"
      ? cloneTemplateContent(await ensureDefaultTemplate())
      : {
          subject: DEFAULT_TEMPLATE_SUBJECT,
          htmlBody: DEFAULT_TEMPLATE_HTML,
        };
  await db.emailTemplate.update({
    where: { id: existing.id },
    data: content,
  });
  revalidatePath("/settings/template");
}

export default async function TemplateSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: SearchParamValue }>;
}) {
  const kind = parseTemplateKind((await searchParams).kind);
  const now = new Date();
  const [template, sample, utmSettings] = await Promise.all([
    ensureTemplate(kind),
    db.show.findFirst({
      where: {
        date: { gte: easternTodayStoredDate(now) },
        syncStatus: "active",
        artists: {
          some: {
            artist: {
              contacts: {
                some: { state: "active", email: { not: null } },
              },
              listenSignals: { some: activeListenSignalWhere(now) },
            },
          },
        },
      },
      include: {
        artists: {
          include: {
            artist: {
              include: {
                contacts: {
                  where: { state: "active" },
                  orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
                },
                listenSignals: {
                  where: activeListenSignalWhere(now),
                  select: { id: true },
                },
              },
            },
          },
        },
      },
      orderBy: { date: "asc" },
    }),
    readEmailUtmSettingsSnapshot(),
  ]);
  const usedVars = extractVars(template.subject + " " + template.htmlBody);
  const allVars = Array.from(new Set([...KNOWN_VARS, ...usedVars])).sort();

  let previewSubject = template.subject;
  let previewHtml = template.htmlBody;
  let sampleLabel = "No sample available";
  let previewArtist: string | null = null;
  if (sample) {
    const matched = sample.artists.find(
      (showArtist) =>
        showArtist.artist.listenSignals.length > 0 &&
        pickEmailContact(showArtist.artist.contacts)
    );
    if (matched) {
      const contact = pickEmailContact(matched.artist.contacts);
      if (!contact) throw new Error("Template sample contact disappeared");
      const sampleVars = await buildVarsForShow({
        artistName: matched.artist.name,
        venueName: sample.venueName,
        showDate: sample.date,
        customPrice: contact.customPrice,
        managerName: contact.name,
      });
      previewSubject = applyTemplate(template.subject, sampleVars);
      previewHtml = renderTrackedEmailHtml(
        template.htmlBody,
        sampleVars,
        kind,
        matched.artist.name,
        utmSettings,
      );
      sampleLabel = `Preview: ${matched.artist.name} at ${sample.venueName}`;
      previewArtist = matched.artist.name;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Email template</h1>
      <nav
        aria-label="Email template type"
        className="mt-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
      >
        {(["original", "follow_up"] as const).map((tab) => (
          <Link
            key={tab}
            href={templateSettingsPath(tab)}
            aria-current={kind === tab ? "page" : undefined}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              kind === tab
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {tab === "original" ? "Original" : "Follow-up"}
          </Link>
        ))}
      </nav>
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
            <input type="hidden" name="kind" value={kind} />
            <TemplateEditor
              key={`${template.name}:${template.updatedAt.toISOString()}`}
              initialSubject={template.subject}
              initialHtml={template.htmlBody}
              variables={allVars}
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <Button type="submit" variant="primary">
                Save {kind === "original" ? "original" : "follow-up"} template
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <form action={resetToDefault} className="mt-3">
        <input type="hidden" name="kind" value={kind} />
        <button type="submit" className="text-xs text-zinc-500 hover:underline">
          {kind === "follow_up"
            ? "Reset from current original"
            : "Reset to built-in default"}
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{sampleLabel}</h2>
        <p className="mt-1 text-xs text-zinc-500">
          {previewArtist
            ? `Web links use the ${kind === "original" ? "original" : "follow-up"} UTM campaign; utm_content is automatically derived from preview artist ${previewArtist}.`
            : "When a sample is available, its web links include the selected message type's UTM campaign and automatic artist utm_content."}
        </p>
        <Card className="mt-3">
          <CardBody>
            <p className="text-xs font-medium text-zinc-500">Subject</p>
            <p className="mt-1 font-medium">{previewSubject}</p>
            <p className="mt-4 text-xs font-medium text-zinc-500">Body</p>
            <iframe
              title={`${
                kind === "original" ? "Original" : "Follow-up"
              } email template preview`}
              sandbox=""
              srcDoc={previewHtml}
              className="mt-1 min-h-80 w-full rounded-md border border-zinc-100 bg-white dark:border-zinc-900"
            />
          </CardBody>
        </Card>
      </section>
    </main>
  );
}
