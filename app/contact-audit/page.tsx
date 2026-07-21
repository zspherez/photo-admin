import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireServerActionAuth } from "@/lib/auth";
import {
  requestContactAudit,
  resolveContactAuditJob,
  type ContactAuditResolution,
} from "@/lib/contactAudit";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { positiveIntegerSearchParam } from "@/lib/searchParams";
import { getPagination } from "@/lib/match";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact audit" };

const PAGE_SIZE = 50;
const WORKFLOW_URL =
  "https://github.com/zspherez/photo-admin/actions/workflows/contact-audit.yml";
const FLAGGED_FINDINGS = ["changed", "stale", "ambiguous"] as const;

function formatTimestamp(value: Date | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(value);
}

function findingTone(finding: string | null): BadgeTone {
  if (finding === "stale") return "danger";
  if (finding === "changed" || finding === "ambiguous") return "warning";
  return "info";
}

function auditHref(
  runId: string,
  page = 1,
  result?: {
    resolution?: ContactAuditResolution;
    error?: string;
  }
): string {
  const params = new URLSearchParams({ run: runId });
  if (page > 1) params.set("page", String(page));
  if (result?.resolution) params.set("resolved", result.resolution);
  if (result?.error) params.set("error", result.error.slice(0, 300));
  return `/contact-audit?${params.toString()}`;
}

function actionContext(formData: FormData): {
  runId: string;
  page: number;
} {
  return {
    runId: String(formData.get("runId") ?? "").trim().slice(0, 100),
    page: positiveIntegerSearchParam(
      String(formData.get("page") ?? "").trim()
    ),
  };
}

async function queueContactAuditAction() {
  "use server";
  await requireServerActionAuth("/contact-audit");
  let result:
    | Awaited<ReturnType<typeof requestContactAudit>>
    | null = null;
  let error: string | null = null;
  try {
    result = await requestContactAudit();
  } catch (caught) {
    console.error(
      JSON.stringify({
        event: "contact_audit_request_failed",
        error: caught instanceof Error ? caught.message : String(caught),
      })
    );
    error = "Unable to queue the contact audit. Please try again.";
  }
  revalidatePath("/contact-audit");
  const params = new URLSearchParams();
  if (result) params.set("request", result.created ? "queued" : "existing");
  if (error) params.set("requestError", error.slice(0, 300));
  redirect(`/contact-audit?${params.toString()}`);
}

async function approveContactAuditAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/contact-audit");
  const context = actionContext(formData);
  const jobId = String(formData.get("jobId") ?? "").trim().slice(0, 100);
  const alternativeId =
    String(formData.get("alternativeId") ?? "").trim().slice(0, 100) || null;
  const result = await resolveContactAuditJob(
    jobId,
    "approved",
    alternativeId
  );
  revalidatePath("/contact-audit");
  redirect(
    auditHref(context.runId, context.page, {
      ...(result.ok ? { resolution: "approved" as const } : {}),
      ...(!result.ok ? { error: result.error ?? "Approval failed." } : {}),
    })
  );
}

async function rejectContactAuditAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/contact-audit");
  const context = actionContext(formData);
  const jobId = String(formData.get("jobId") ?? "").trim().slice(0, 100);
  const result = await resolveContactAuditJob(jobId, "rejected", null);
  revalidatePath("/contact-audit");
  redirect(
    auditHref(context.runId, context.page, {
      ...(result.ok ? { resolution: "rejected" as const } : {}),
      ...(!result.ok ? { error: result.error ?? "Rejection failed." } : {}),
    })
  );
}

export default async function ContactAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    run?: SearchParamValue;
    page?: SearchParamValue;
    resolved?: SearchParamValue;
    error?: SearchParamValue;
    request?: SearchParamValue;
    requestError?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const requestedRunId = firstSearchParam(raw.run)?.slice(0, 100) ?? null;
  const requestedPage = positiveIntegerSearchParam(raw.page);
  const rawResolved = firstSearchParam(raw.resolved);
  const resolved =
    rawResolved === "approved" || rawResolved === "rejected"
      ? rawResolved
      : null;
  const actionError = firstSearchParam(raw.error);
  const requestResult = firstSearchParam(raw.request);
  const requestError = firstSearchParam(raw.requestError);
  const runs = await db.contactAuditRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { _count: { select: { jobs: true } } },
  });
  const latestRequest = await db.contactAuditRequest.findFirst({
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      status: true,
      requestedAt: true,
      startedAt: true,
      completedAt: true,
      runId: true,
      attemptCount: true,
      lastAttemptAt: true,
      lastWorkflowRunId: true,
      lastError: true,
    },
  });
  const requestActive =
    latestRequest?.status === "pending" || latestRequest?.status === "running";
  const diagnosticWorkflowUrl = latestRequest?.lastWorkflowRunId
    ? `https://github.com/zspherez/photo-admin/actions/runs/${latestRequest.lastWorkflowRunId}`
    : WORKFLOW_URL;
  const selectedRun =
    (requestedRunId
      ? runs.find((run) => run.id === requestedRunId) ??
        (await db.contactAuditRun.findUnique({
          where: { id: requestedRunId },
          include: { _count: { select: { jobs: true } } },
        }))
      : null) ??
    runs[0] ??
    null;

  const where: Prisma.ContactAuditJobWhereInput = selectedRun
    ? {
        runId: selectedRun.id,
        status: "complete",
        finding: { in: [...FLAGGED_FINDINGS] },
        resolution: null,
      }
    : { id: "__no_contact_audit_run__" };
  const [total, statusCounts] = selectedRun
    ? await Promise.all([
        db.contactAuditJob.count({ where }),
        db.contactAuditJob.groupBy({
          by: ["status"],
          where: { runId: selectedRun.id },
          _count: { _all: true },
        }),
      ])
    : [0, []];
  const pagination = getPagination(total, requestedPage, PAGE_SIZE);
  const jobs = selectedRun
    ? await db.contactAuditJob.findMany({
        where,
        orderBy: [{ verifiedAt: "desc" }, { createdAt: "asc" }],
        skip: (pagination.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          alternatives: { orderBy: { createdAt: "asc" } },
          contact: {
            select: {
              id: true,
              email: true,
              phone: true,
              directOutreachNote: true,
              name: true,
              role: true,
              source: true,
              state: true,
            },
          },
          artist: { select: { id: true } },
        },
      })
    : [];
  const countByStatus = new Map(
    statusCounts.map((row) => [row.status, row._count._all])
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Contact audit decisions
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Review only contacts flagged for a change, then approve the saved
            replacement or reject the finding here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={queueContactAuditAction}>
            <PendingSubmitButton
              pendingLabel="Queueing audit…"
              disabled={requestActive}
            >
              {requestActive
                ? latestRequest?.status === "running"
                  ? "Full audit running"
                  : "Full audit queued"
                : "Queue full contact audit"}
            </PendingSubmitButton>
          </form>
          <LinkButton
            href={diagnosticWorkflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
          >
            Workflow diagnostics ↗
          </LinkButton>
        </div>
      </div>

      {(requestResult === "queued" || requestResult === "existing") && (
        <div
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          role="status"
        >
          {requestResult === "queued"
            ? "Full contact audit queued. GitHub Actions polls every 10 minutes."
            : "A full contact audit was already queued or running; the existing request was kept."}
        </div>
      )}
      {requestError && (
        <div
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          role="alert"
        >
          {requestError}
        </div>
      )}
      {resolved && (
        <div
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          role="status"
        >
          Decision saved. The finding was {resolved} and removed from this
          queue.
        </div>
      )}
      {actionError && (
        <div
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          role="alert"
        >
          {actionError}
        </div>
      )}

      {latestRequest && (
        <Card className="mt-5">
          <CardBody className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Full audit request
                </p>
                <p className="mt-1 text-sm font-medium capitalize">
                  {latestRequest.status}
                </p>
              </div>
              <Badge
                tone={
                  latestRequest.status === "failed"
                    ? "danger"
                    : latestRequest.status === "completed"
                      ? "info"
                      : "warning"
                }
              >
                {latestRequest.status}
              </Badge>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Requested {formatTimestamp(latestRequest.requestedAt)}
              {latestRequest.startedAt
                ? ` · started ${formatTimestamp(latestRequest.startedAt)}`
                : ""}
              {latestRequest.completedAt
                ? ` · completed ${formatTimestamp(latestRequest.completedAt)}`
                : ""}
              {latestRequest.lastAttemptAt
                ? ` · last poll ${formatTimestamp(latestRequest.lastAttemptAt)}`
                : ""}
              {` · ${latestRequest.attemptCount} attempt${
                latestRequest.attemptCount === 1 ? "" : "s"
              }`}
            </p>
            {latestRequest.lastError && (
              <p
                className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200"
                role="alert"
              >
                Last attempt: {latestRequest.lastError}.{" "}
                {requestActive
                  ? "The request remains queued for retry."
                  : "Queue another full audit when the issue is resolved."}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {runs.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2" aria-label="Audit runs">
          {runs.map((run, index) => (
            <LinkButton
              key={run.id}
              href={auditHref(run.id)}
              variant={run.id === selectedRun?.id ? "primary" : "secondary"}
              size="sm"
            >
              {index === 0 ? "Latest · " : ""}
              {formatTimestamp(run.createdAt)}
            </LinkButton>
          ))}
        </div>
      )}

      {!selectedRun ? (
        <Card className="mt-6">
          <CardBody className="py-12 text-center text-sm text-zinc-500">
            No audit has been run yet. Queue a full audit above; the next
            scheduled poll will snapshot and verify every active contact.
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Decisions needed", total],
              ["Queued", countByStatus.get("pending") ?? 0],
              ["Researching", countByStatus.get("claimed") ?? 0],
              ["Completed", countByStatus.get("complete") ?? 0],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardBody className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              Unresolved changed, stale, and ambiguous findings
            </p>
            <p className="text-xs text-zinc-500">
              Run {selectedRun.status} · started{" "}
              {formatTimestamp(selectedRun.createdAt)}
              {selectedRun.completedAt
                ? ` · completed ${formatTimestamp(selectedRun.completedAt)}`
                : ""}
            </p>
          </div>

          {jobs.length === 0 ? (
            <Card className="mt-3">
              <CardBody className="py-10 text-center text-sm text-zinc-500">
                No unresolved contact decisions remain for this run.
              </CardBody>
            </Card>
          ) : (
            <div className="mt-3 space-y-3">
              {jobs.map((job) => (
                <Card key={job.id}>
                  <CardBody>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        {job.artist ? (
                          <Link
                            href={`/artists/${job.artist.id}`}
                            className="font-medium hover:underline"
                          >
                            {job.snapshotArtistName}
                          </Link>
                        ) : (
                          <p className="font-medium">
                            {job.snapshotArtistName}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={findingTone(job.finding)}>
                          {job.finding}
                        </Badge>
                        {job.confidence && (
                          <Badge tone="muted">{job.confidence}</Badge>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Current contact
                      </p>
                      {job.contact ? (
                        <>
                          <p className="mt-1 break-all text-sm font-medium">
                            {job.contact.name
                              ? `${job.contact.name} · `
                              : ""}
                            {job.contact.email ??
                              job.contact.phone ??
                              job.contact.directOutreachNote ??
                              "No contact target"}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            {job.contact.role ?? "No role"}
                            {job.contact.source
                              ? ` · source: ${job.contact.source}`
                              : ""}
                            {` · ${job.contact.state}`}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-red-700 dark:text-red-300">
                          This contact no longer exists. Run a new audit before
                          resolving this finding.
                        </p>
                      )}
                    </div>

                    {job.evidence && (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Saved evidence
                        </p>
                        <p className="mt-1 text-sm">{job.evidence}</p>
                      </div>
                    )}
                    {job.sourceUrls.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                        {job.sourceUrls.map((url, index) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-xs text-blue-700 hover:underline dark:text-blue-300"
                          >
                            Verification source {index + 1} ↗
                          </a>
                        ))}
                      </div>
                    )}
                    {job.verifiedAt && (
                      <p className="mt-2 text-xs text-zinc-500">
                        Verified {formatTimestamp(job.verifiedAt)}
                      </p>
                    )}
                    {job.agentNotes && (
                      <p className="mt-2 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                        {job.agentNotes}
                      </p>
                    )}

                    {(job.finding === "changed" ||
                      job.finding === "ambiguous") && (
                      <div className="mt-4">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Proposed manager contacts
                        </h2>
                        <div className="mt-2 space-y-2">
                          {job.alternatives.map((alternative) => (
                            <div
                              key={alternative.id}
                              className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="break-all text-sm font-medium">
                                  {alternative.email}
                                </span>
                                <Badge tone="muted">
                                  {alternative.confidence}
                                </Badge>
                              </div>
                              {alternative.name && (
                                <p className="mt-1 text-xs text-zinc-500">
                                  {alternative.name} · management
                                </p>
                              )}
                              <p className="mt-2 text-sm">
                                {alternative.evidence}
                              </p>
                              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                                {alternative.sourceUrls.map((url, index) => (
                                  <a
                                    key={url}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="break-all text-xs text-blue-700 hover:underline dark:text-blue-300"
                                  >
                                    Alternative source {index + 1} ↗
                                  </a>
                                ))}
                              </div>
                              <form
                                action={approveContactAuditAction}
                                className="mt-3"
                              >
                                <input
                                  type="hidden"
                                  name="jobId"
                                  value={job.id}
                                />
                                <input
                                  type="hidden"
                                  name="alternativeId"
                                  value={alternative.id}
                                />
                                <input
                                  type="hidden"
                                  name="runId"
                                  value={selectedRun.id}
                                />
                                <input
                                  type="hidden"
                                  name="page"
                                  value={pagination.page}
                                />
                                <PendingSubmitButton
                                  size="sm"
                                  pendingLabel="Applying contact…"
                                  className="w-full sm:w-auto"
                                  disabled={!job.contact}
                                >
                                  Approve and apply this contact
                                </PendingSubmitButton>
                              </form>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.finding === "stale" && (
                      <form
                        action={approveContactAuditAction}
                        className="mt-4"
                      >
                        <input type="hidden" name="jobId" value={job.id} />
                        <input
                          type="hidden"
                          name="runId"
                          value={selectedRun.id}
                        />
                        <input
                          type="hidden"
                          name="page"
                          value={pagination.page}
                        />
                        <PendingSubmitButton
                          variant="danger"
                          size="sm"
                          pendingLabel="Marking inactive…"
                          className="w-full sm:w-auto"
                          disabled={!job.contact}
                        >
                          Approve stale — mark contact inactive
                        </PendingSubmitButton>
                      </form>
                    )}

                    <form
                      action={rejectContactAuditAction}
                      className="mt-3"
                    >
                      <input type="hidden" name="jobId" value={job.id} />
                      <input
                        type="hidden"
                        name="runId"
                        value={selectedRun.id}
                      />
                      <input
                        type="hidden"
                        name="page"
                        value={pagination.page}
                      />
                      <PendingSubmitButton
                        variant="secondary"
                        size="sm"
                        pendingLabel="Rejecting finding…"
                        className="w-full sm:w-auto"
                        disabled={!job.contact}
                      >
                        Reject finding — keep current contact active
                      </PendingSubmitButton>
                    </form>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}

          {pagination.pageCount > 1 && (
            <nav
              aria-label="Contact audit decision pages"
              className="mt-5 flex items-center justify-between gap-3"
            >
              {pagination.hasPrevious ? (
                <LinkButton
                  href={auditHref(selectedRun.id, pagination.page - 1)}
                  variant="secondary"
                >
                  Previous
                </LinkButton>
              ) : (
                <span />
              )}
              <span className="text-xs text-zinc-500">
                Page {pagination.page} of {pagination.pageCount}
              </span>
              {pagination.hasNext ? (
                <LinkButton
                  href={auditHref(selectedRun.id, pagination.page + 1)}
                  variant="secondary"
                >
                  Next
                </LinkButton>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
