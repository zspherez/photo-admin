import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { cancelArbitraryEmailAction } from "@/app/emails/actions";
import { db } from "@/lib/db";
import { getPagination } from "@/lib/match";
import { formatScheduledTime } from "@/lib/schedule";
import {
  firstSearchParam,
  positiveIntegerSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Emails" };

const PAGE_SIZE = 50;

function statusTone(status: string): BadgeTone {
  if (status === "failed") return "danger";
  if (status === "manual_review") return "warning";
  if (status === "test") return "warning";
  if (
    status === "scheduled" ||
    status === "retry_scheduled" ||
    status === "queued"
  ) {
    return "warning";
  }
  if (status === "sent") return "success";
  return "default";
}

function emailsHref(page: number): string {
  return page > 1 ? `/emails?page=${page}` : "/emails";
}

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: SearchParamValue;
    sent?: SearchParamValue;
    queued?: SearchParamValue;
    cancelled?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const sp = await searchParams;
  const requestedPage = positiveIntegerSearchParam(sp.page);
  const sent = firstSearchParam(sp.sent);
  const queued = firstSearchParam(sp.queued);
  const cancelled = firstSearchParam(sp.cancelled);
  const error = firstSearchParam(sp.error);
  const queuedEmail = queued
    ? await db.arbitraryEmail.findUnique({
        where: { id: queued },
        select: { scheduledFor: true },
      })
    : null;
  const [total, delivered, opened, clicked] = await Promise.all([
    db.arbitraryEmail.count(),
    db.arbitraryEmail.count({ where: { deliveredAt: { not: null } } }),
    db.arbitraryEmail.count({ where: { openCount: { gt: 0 } } }),
    db.arbitraryEmail.count({ where: { clickCount: { gt: 0 } } }),
  ]);
  const pagination = getPagination(total, requestedPage, PAGE_SIZE);
  if (pagination.page !== requestedPage) redirect(emailsHref(pagination.page));

  const emails = await db.arbitraryEmail.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (pagination.page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      recipientEmails: true,
      subject: true,
      html: true,
      text: true,
      status: true,
      error: true,
      sentAt: true,
      scheduledFor: true,
      nextAttemptAt: true,
      createdAt: true,
      deliveredAt: true,
      openCount: true,
      clickCount: true,
    },
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Emails</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Custom emails and their Resend delivery and engagement statistics.
          </p>
        </div>
        <LinkButton href="/emails/new">Compose</LinkButton>
      </div>

      {(sent || queued || cancelled || error) && (
        <div className={`mt-5 rounded-lg border px-4 py-3 text-sm ${
          error
            ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
        }`}>
          {error
            ? `Email action failed: ${error}`
            : queued
              ? queuedEmail?.scheduledFor
                ? `Email queued for ${formatScheduledTime(
                    queuedEmail.scheduledFor,
                  )} ET.`
                : "Email queued."
              : cancelled
                ? "Queued email cancelled."
                : "Email sent."}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Total", total],
          ["Delivered", delivered],
          ["Opened", opened],
          ["Clicked links", clicked],
        ].map(([label, value]) => (
          <Card key={label} className="p-3">
            <div className="text-2xl font-semibold">{Number(value).toLocaleString()}</div>
            <div className="text-xs text-zinc-500">{label}</div>
          </Card>
        ))}
      </div>

      {emails.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No custom emails yet.
        </div>
      ) : (
        <div className="mt-6 sm:overflow-hidden sm:rounded-xl sm:border sm:border-zinc-200 sm:dark:border-zinc-800">
          <div className="sm:overflow-x-auto">
            <table className="mobile-stack w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Delivered</th>
                  <th className="px-4 py-3">Opens</th>
                  <th className="px-4 py-3">Clicks</th>
                  <th className="px-4 py-3">Target / sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {emails.map((email) => (
                  <tr key={email.id}>
                    <td data-label="Email" className="max-w-md px-4 py-3">
                      <div className="truncate font-medium">{email.subject}</div>
                      <div className="truncate text-xs text-zinc-500">
                        {email.recipientEmails.join(", ")}
                      </div>
                      {email.error && (
                        <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                          {email.error}
                        </div>
                      )}
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-zinc-500">
                          Canonical content
                        </summary>
                        <div className="mt-2 space-y-2">
                          <div>
                            <div className="font-medium text-zinc-700 dark:text-zinc-300">
                              Plain text
                            </div>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                              {email.text ??
                                "Plain-text snapshot unavailable for this legacy email."}
                            </pre>
                          </div>
                          <div>
                            <div className="font-medium text-zinc-700 dark:text-zinc-300">
                              Canonical HTML source
                            </div>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 text-[11px] dark:bg-zinc-900">
                              {email.html}
                            </pre>
                          </div>
                        </div>
                      </details>
                    </td>
                    <td data-label="Status" className="px-4 py-3">
                      <Badge tone={statusTone(email.status)}>{email.status.replace("_", " ")}</Badge>
                      {["scheduled", "retry_scheduled"].includes(
                        email.status,
                      ) && (
                        <form
                          action={cancelArbitraryEmailAction}
                          className="mt-2"
                        >
                          <input type="hidden" name="id" value={email.id} />
                          <PendingSubmitButton
                            variant="ghost"
                            size="sm"
                            pendingLabel="Cancelling…"
                          >
                            Cancel
                          </PendingSubmitButton>
                        </form>
                      )}
                    </td>
                    <td data-label="Delivered" className="px-4 py-3">{email.deliveredAt ? "Yes" : "—"}</td>
                    <td data-label="Opens" className="px-4 py-3">{email.openCount}</td>
                    <td data-label="Clicks" className="px-4 py-3">{email.clickCount}</td>
                    <td data-label="Target / sent" className="whitespace-nowrap px-4 py-3 text-zinc-500">
                      {email.sentAt
                        ? email.sentAt.toLocaleString()
                        : email.nextAttemptAt
                          ? `${formatScheduledTime(email.nextAttemptAt)} ET`
                          : email.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pagination.pageCount > 1 && (
        <div className="mt-6 flex items-center justify-between text-sm">
          {pagination.page > 1 ? (
            <Link href={emailsHref(pagination.page - 1)}>Previous</Link>
          ) : <span />}
          <span className="text-zinc-500">
            Page {pagination.page} of {pagination.pageCount}
          </span>
          {pagination.hasNext ? (
            <Link href={emailsHref(pagination.page + 1)}>Next</Link>
          ) : <span />}
        </div>
      )}
    </main>
  );
}
