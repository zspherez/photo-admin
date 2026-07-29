import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_SUBJECT,
  FESTIVAL_TEMPLATE_HTML,
  FESTIVAL_TEMPLATE_SUBJECT,
  FOLLOW_UP_TEMPLATE_HTML,
  FOLLOW_UP_TEMPLATE_SUBJECT,
  applyTemplate,
  buildVarsForShow,
  ensureDefaultTemplate,
  ensureFestivalTemplate,
  ensureFollowUpTemplate,
  extractVars,
  malformedTemplateVariableTokens,
  normalizeTemplateContent,
  readTemplateForPurpose,
  readOnlyTemplateForPurpose,
  supportedTemplateVars,
  unsupportedTemplateVars,
} from "@/lib/template";
import { renderTrackedEmailHtml } from "@/lib/emailUtm";
import { readEmailUtmSettingsSnapshot } from "@/lib/generalSettings";
import { TemplateEditor } from "@/components/template-editor";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import { pickEmailContact } from "@/lib/contactSelection";
import { activeListenSignalWhere } from "@/lib/listenSignal";
import { festivalLeadTimeWhere } from "@/lib/festivalEligibility";
import {
  SESSION_COOKIE,
  getSessionAccess,
  requireServerActionAuth,
} from "@/lib/auth";
import {
  firstSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";
import { artistDisplayName } from "@/lib/artistDisplayName";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email template" };

type TemplateKind = "original" | "festival" | "follow_up";

function parseTemplateKind(value: unknown): TemplateKind {
  const kind = firstSearchParam(value);
  return kind === "festival" || kind === "follow_up" ? kind : "original";
}

function requiredTemplateKind(value: FormDataEntryValue | null): TemplateKind {
  if (
    value === "original" ||
    value === "festival" ||
    value === "follow_up"
  ) {
    return value;
  }
  throw new Error("Invalid email template kind");
}

function templateSettingsPath(kind: TemplateKind): string {
  return kind === "original"
    ? "/settings/template"
    : `/settings/template?kind=${kind}`;
}

function templateSettingsResultPath(
  kind: TemplateKind,
  result: { saved?: string; reset?: string; error?: string },
): string {
  const params = new URLSearchParams();
  if (kind !== "original") params.set("kind", kind);
  for (const [key, value] of Object.entries(result)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/settings/template?${query}` : "/settings/template";
}

async function ensureTemplate(kind: TemplateKind) {
  if (kind === "festival") return ensureFestivalTemplate();
  if (kind === "follow_up") return ensureFollowUpTemplate();
  return ensureDefaultTemplate();
}

function readTemplate(kind: TemplateKind) {
  return readTemplateForPurpose(kind);
}

function templateLabel(kind: TemplateKind): string {
  if (kind === "festival") return "Festival outreach";
  if (kind === "follow_up") return "Follow-up";
  return "Normal show outreach";
}

function templateUtmKind(kind: TemplateKind): "original" | "follow_up" {
  return kind === "follow_up" ? "follow_up" : "original";
}

async function saveTemplate(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/template");
  let kind: TemplateKind;
  try {
    kind = requiredTemplateKind(formData.get("kind"));
  } catch {
    redirect(
      templateSettingsResultPath("original", {
        error: "Invalid email template type.",
      }),
    );
  }
  let content: ReturnType<typeof normalizeTemplateContent>;
  try {
    content = normalizeTemplateContent({
      subject: String(formData.get("subject") ?? "").trim(),
      htmlBody: String(formData.get("html") ?? ""),
    });
  } catch {
    redirect(
      templateSettingsResultPath(kind, {
        error: "Template content could not be normalized.",
      }),
    );
  }
  const { subject, htmlBody } = content;
  if (!subject || !htmlBody) {
    redirect(
      templateSettingsResultPath(kind, {
        error: "Subject and body are required.",
      }),
    );
  }
  const malformed = malformedTemplateVariableTokens(content);
  if (malformed.length > 0) {
    redirect(
      templateSettingsResultPath(kind, {
        error: `Malformed ${templateLabel(kind).toLowerCase()} variable token(s): ${malformed.join(", ")}`,
      }),
    );
  }
  const unsupported = unsupportedTemplateVars(content, kind);
  if (unsupported.length > 0) {
    redirect(
      templateSettingsResultPath(kind, {
        error: `Unsupported ${templateLabel(kind).toLowerCase()} variable(s): ${unsupported
          .map((variable) => `{{${variable}}}`)
          .join(", ")}`,
      }),
    );
  }
  try {
    const existing = await ensureTemplate(kind);
    await db.emailTemplate.update({
      where: { id: existing.id },
      data: { subject, htmlBody },
    });
  } catch (error) {
    console.error("Unable to save email template", error);
    redirect(
      templateSettingsResultPath(kind, {
        error: "Template could not be saved. Try again.",
      }),
    );
  }
  revalidatePath("/settings/template");
  revalidatePath("/");
  redirect(templateSettingsResultPath(kind, { saved: "1" }));
}

async function resetToDefault(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/template");
  const kind = requiredTemplateKind(formData.get("kind"));
  const existing = await ensureTemplate(kind);
  const content =
    kind === "follow_up"
      ? {
          subject: FOLLOW_UP_TEMPLATE_SUBJECT,
          htmlBody: FOLLOW_UP_TEMPLATE_HTML,
        }
      : kind === "festival"
        ? {
            subject: FESTIVAL_TEMPLATE_SUBJECT,
            htmlBody: FESTIVAL_TEMPLATE_HTML,
          }
        : {
            subject: DEFAULT_TEMPLATE_SUBJECT,
            htmlBody: DEFAULT_TEMPLATE_HTML,
          };
  await db.emailTemplate.update({
    where: { id: existing.id },
    data: content,
  });
  revalidatePath("/settings/template");
  redirect(templateSettingsResultPath(kind, { reset: "1" }));
}

export default async function TemplateSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: SearchParamValue;
    saved?: SearchParamValue;
    reset?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const search = await searchParams;
  const kind = parseTemplateKind(search.kind);
  const saved = firstSearchParam(search.saved);
  const reset = firstSearchParam(search.reset);
  const actionError = firstSearchParam(search.error);
  const now = new Date();
  const access = await getSessionAccess(
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  const [template, sample, utmSettings] = await Promise.all([
    access === "read_only"
      ? Promise.resolve(readOnlyTemplateForPurpose(kind))
      : readTemplate(kind),
    db.show.findFirst({
      where: {
        date: { gte: easternTodayStoredDate(now) },
        syncStatus: "active",
        ...(kind === "follow_up"
          ? {}
          : { isFestival: kind === "festival" }),
        AND: [festivalLeadTimeWhere(now)],
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
  const allVars = [...supportedTemplateVars(kind)].sort();

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
      const sampleArtistName = artistDisplayName(matched.artist);
      const sampleVars = await buildVarsForShow({
        artistName: sampleArtistName,
        venueName: sample.venueName,
        showDate: sample.date,
        managerName: contact.name,
        eventName: sample.eventName,
        city: sample.city,
        state: sample.state,
        countryCode: sample.countryCode,
        countryName: sample.countryName,
      });
      previewSubject = applyTemplate(template.subject, sampleVars);
      previewHtml = renderTrackedEmailHtml(
        template.htmlBody,
        sampleVars,
        templateUtmKind(kind),
        sampleArtistName,
        utmSettings,
      );
      sampleLabel = `Preview: ${sampleArtistName} at ${sample.venueName}`;
      previewArtist = sampleArtistName;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Settings</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Email template</h1>
      {(saved || reset) && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        >
          {reset ? "Template reset to the built-in default." : "Template saved."}
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {actionError}
        </div>
      )}
      <nav
        aria-label="Email template type"
        className="mt-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
      >
        {(["original", "festival", "follow_up"] as const).map((tab) => (
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
            {templateLabel(tab)}
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
              disabled={access === "read_only"}
            />
            <div className="mobile-sticky-actions mt-4 flex items-center justify-between gap-2">
              <PendingSubmitButton
                variant="primary"
                pendingLabel="Saving template…"
                disabled={access === "read_only"}
              >
                Save {templateLabel(kind).toLowerCase()} template
              </PendingSubmitButton>
            </div>
          </form>
        </CardBody>
      </Card>

      <form action={resetToDefault} className="mt-3">
        <input type="hidden" name="kind" value={kind} />
        <button
          type="submit"
          disabled={access === "read_only"}
          className="text-xs text-zinc-500 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reset to built-in default
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{sampleLabel}</h2>
        <p className="mt-1 text-xs text-zinc-500">
          {previewArtist
            ? `Web links use the ${templateUtmKind(kind) === "original" ? "original" : "follow-up"} UTM campaign; utm_content is automatically derived from preview artist ${previewArtist}.`
            : "When a sample is available, its web links include the selected message type's UTM campaign and automatic artist utm_content."}
        </p>
        <Card className="mt-3">
          <CardBody>
            <p className="text-xs font-medium text-zinc-500">Subject</p>
            <p className="mt-1 font-medium">{previewSubject}</p>
            <p className="mt-4 text-xs font-medium text-zinc-500">Body</p>
            <iframe
              title={`${
                templateLabel(kind)
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
