import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  DEFAULT_NEW_YEAR_PITCH,
  NEW_YEAR_PITCH_TEMPLATE_NAME,
  NEW_YEAR_PITCH_VARIABLES,
  readNewYearPitchTemplate,
  validateNewYearPitchTemplate,
} from "@/lib/newYearPitch";
import { normalizeTemplateContent } from "@/lib/template";
import { getSessionAccess, requireServerActionAuth, SESSION_COOKIE } from "@/lib/auth";
import { TemplateEditor } from "@/components/template-editor";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { Card, CardBody } from "@/components/ui/card";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New Year's pitch template" };

async function saveNewYearPitch(formData: FormData) {
  "use server";
  await requireServerActionAuth("/new-years-runs/template");
  const content = normalizeTemplateContent({
    subject: String(formData.get("subject") ?? "").trim(),
    htmlBody: String(formData.get("html") ?? "").trim(),
  });
  if (!content.subject || !content.htmlBody) {
    redirect("/new-years-runs/template?error=Subject+and+body+are+required");
  }
  const unsupported = validateNewYearPitchTemplate(content);
  if (unsupported.length > 0) {
    redirect(`/new-years-runs/template?error=${encodeURIComponent(`Invalid template variable: ${unsupported.join(", ")}`)}`);
  }
  await db.emailTemplate.upsert({
    where: { name: NEW_YEAR_PITCH_TEMPLATE_NAME },
    create: { name: NEW_YEAR_PITCH_TEMPLATE_NAME, ...content },
    update: content,
  });
  revalidatePath("/new-years-runs/template");
  redirect("/new-years-runs/template?saved=1");
}

async function resetNewYearPitch() {
  "use server";
  await requireServerActionAuth("/new-years-runs/template");
  await db.emailTemplate.upsert({
    where: { name: NEW_YEAR_PITCH_TEMPLATE_NAME },
    create: { name: NEW_YEAR_PITCH_TEMPLATE_NAME, ...DEFAULT_NEW_YEAR_PITCH },
    update: DEFAULT_NEW_YEAR_PITCH,
  });
  revalidatePath("/new-years-runs/template");
  redirect("/new-years-runs/template?reset=1");
}

export default async function NewYearPitchTemplatePage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: SearchParamValue;
    reset?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const status = await searchParams;
  const access = await getSessionAccess(
    (await cookies()).get(SESSION_COOKIE)?.value
  );
  const template = access === "read_only"
    ? { subject: "Lorem ipsum", htmlBody: "<p>Lorem ipsum dolor sit amet.</p>" }
    : await readNewYearPitchTemplate();
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/new-years-runs" className="text-sm text-zinc-500 underline">
        Back to New Year&apos;s runs
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">New Year&apos;s pitch template</h1>
      <p className="mt-1 text-sm text-zinc-500">
        This template only prefills the compose form. Every message can be edited before sending.
      </p>
      {(firstSearchParam(status.saved) || firstSearchParam(status.reset)) && (
        <p role="status" className="mt-4 text-sm text-emerald-700">Template saved.</p>
      )}
      {firstSearchParam(status.error) && (
        <p role="alert" className="mt-4 text-sm text-red-700">{firstSearchParam(status.error)}</p>
      )}
      <Card className="mt-6">
        <CardBody>
          <form action={saveNewYearPitch}>
            <TemplateEditor
              key={`${template.subject}:${template.htmlBody}`}
              initialSubject={template.subject}
              initialHtml={template.htmlBody}
              variables={[...NEW_YEAR_PITCH_VARIABLES]}
              disabled={access === "read_only"}
            />
            <div className="mt-4">
              <PendingSubmitButton pendingLabel="Saving…" disabled={access === "read_only"}>Save pitch template</PendingSubmitButton>
            </div>
          </form>
        </CardBody>
      </Card>
      <form action={resetNewYearPitch} className="mt-4">
        <button type="submit" disabled={access === "read_only"} className="text-sm text-zinc-500 underline disabled:opacity-50">
          Reset to default
        </button>
      </form>
    </main>
  );
}
