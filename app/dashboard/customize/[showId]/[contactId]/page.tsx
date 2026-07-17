import type { Metadata } from "next";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  dashboardResultHref,
  festivalReturnPath,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import {
  getOutreachSendabilityBatch,
  sendOutreach,
  scheduleOutreach,
} from "@/lib/sendOutreach";
import { isWeekendET, getNextMondaySlot } from "@/lib/schedule";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  ensureDefaultTemplate,
} from "@/lib/template";
import { Card, CardBody } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { TemplateEditor } from "@/components/template-editor";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { formatShowDate } from "@/lib/formatDate";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { refreshWorkflowViews } from "@/lib/workflowRefresh";

export const dynamic = "force-dynamic";

const getCustomizeContext = cache(
  async (showId: string, contactId: string) =>
    Promise.all([
      db.show.findUnique({ where: { id: showId } }),
      db.contact.findFirst({
        where: { id: contactId, state: "active" },
        include: { artist: true },
      }),
    ]),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ showId: string; contactId: string }>;
}): Promise<Metadata> {
  const { showId, contactId } = await params;
  const [show, contact] = await getCustomizeContext(showId, contactId);
  return {
    title:
      show && contact
        ? `Customize ${contact.artist.name} at ${
            show.eventName || show.venueName
          }`
        : "Customize outreach",
  };
}

async function sendCustom(formData: FormData) {
  "use server";
  await requireServerActionAuth(formData.get("returnTo") ?? "/dashboard");
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  const showId = formData.get("showId") as string;
  const contactId = formData.get("contactId") as string;
  const subjectOverride = (formData.get("subject") as string) ?? "";
  const htmlOverride = (formData.get("html") as string) ?? "";
  const [show, contact] = await Promise.all([
    db.show.findUnique({
      where: { id: showId },
      select: { syncStatus: true },
    }),
    db.contact.findFirst({
      where: { id: contactId, state: "active" },
      select: { email: true },
    }),
  ]);
  if (!show || show.syncStatus !== "active") {
    redirect(dashboardResultHref(returnTo, "error", "Show is inactive"));
  }
  if (!contact?.email?.trim()) {
    redirect(
      dashboardResultHref(returnTo, "error", "Selected contact has no email")
    );
  }

  if (isWeekendET()) {
    const result = await scheduleOutreach({ showId, contactId, subjectOverride, htmlOverride }, getNextMondaySlot());
    refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
    if (result.ok) {
      redirect(dashboardResultHref(returnTo, "scheduled"));
    } else {
      redirect(
        dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
      );
    }
  }

  const result = await sendOutreach({ showId, contactId, subjectOverride, htmlOverride });
  refreshWorkflowViews(returnTo, ["/outreach", festivalReturnPath(showId)]);
  if (result.ok) {
    redirect(dashboardResultHref(returnTo, "sent"));
  } else {
    redirect(
      dashboardResultHref(returnTo, "error", result.error ?? "Unknown error")
    );
  }
}

export default async function CustomizePage({
  params,
  searchParams,
}: {
  params: Promise<{ showId: string; contactId: string }>;
  searchParams: Promise<{ returnTo?: SearchParamValue }>;
}) {
  const { showId, contactId } = await params;
  const search = await searchParams;
  const safeReturnTo = workflowReturnPath(firstSearchParam(search.returnTo));
  const [[show, contact], template, sendabilityRows] = await Promise.all([
    getCustomizeContext(showId, contactId),
    ensureDefaultTemplate(),
    getOutreachSendabilityBatch([{ showId, contactId }]),
  ]);
  if (!show || !contact) return notFound();
  const sendability = sendabilityRows[0];
  const canSend = sendability?.sendable === true;
  const isRetry = canSend && sendability.mode === "retry";
  const weekend = isWeekendET();

  const vars = await buildVarsForShow({
    artistName: contact.artist.name,
    venueName: show.venueName,
    showDate: show.date,
    customPrice: contact.customPrice,
    managerName: contact.name,
  });
  const subject = applyTemplate(template.subject, vars);
  const html = applyHtmlTemplate(template.htmlBody, vars);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href={safeReturnTo} className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Back</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Customize &amp; send</h1>
      <p className="mt-1 text-sm text-zinc-500">
        To{" "}
        <b>
          {contact.email
            ? contact.name
              ? `${contact.name} <${contact.email}>`
              : contact.email
            : contact.name ?? "contact without email"}
        </b>{" "}
        · {contact.artist.name} at {show.venueName},{" "}
        {formatShowDate(show.date, {})}
      </p>
      {!canSend && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {show.syncStatus !== "active"
            ? "This show is inactive. Email outreach is disabled."
            : !contact.email?.trim()
              ? "This contact has no email address. Add one before sending."
              : sendability?.reason ?? "Email outreach is unavailable."}
        </div>
      )}
      {isRetry && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          This retry will reuse the original immutable recipients, subject,
          body, and attachment snapshot. Editing is disabled.
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <form action={sendCustom} className="space-y-4">
            <input type="hidden" name="showId" value={showId} />
            <input type="hidden" name="contactId" value={contactId} />
            <input type="hidden" name="returnTo" value={safeReturnTo} />
            {isRetry ? (
              <>
                <input type="hidden" name="subject" value={subject} />
                <input type="hidden" name="html" value={html} />
              </>
            ) : (
              <TemplateEditor
                initialSubject={subject}
                initialHtml={html}
                variables={[]}
              />
            )}
            <div className="flex gap-2">
              {canSend && (
                <PendingSubmitButton
                  variant="primary"
                  pendingLabel={
                    isRetry
                      ? weekend
                        ? "Scheduling retry…"
                        : "Retrying…"
                      : weekend
                        ? "Scheduling…"
                        : "Sending…"
                  }
                >
                  {isRetry
                    ? weekend
                      ? "Schedule retry"
                      : "Retry now"
                    : weekend
                      ? "Schedule Monday"
                      : "Send now"}
                </PendingSubmitButton>
              )}
              <LinkButton href={safeReturnTo} variant="secondary">Cancel</LinkButton>
            </div>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
