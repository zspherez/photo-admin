import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireServerActionAuth } from "@/lib/auth";
import { requestContactAudit } from "@/lib/contactAudit";
import {
  CONTACT_AUDIT_ARTIST_ACTIONS,
  resolveContactAuditArtist,
  type ContactAuditArtistAction,
} from "@/lib/contactAuditArtistDecision";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { positiveIntegerSearchParam } from "@/lib/searchParams";
import { getPagination } from "@/lib/match";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact audit" };

const PAGE_SIZE = 30;
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

type RosterReview = {
  rosterEntryId: string;
  assessment: string;
  notes: string;
};

function rosterReviews(value: Prisma.JsonValue | null): Map<string, RosterReview> {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof item.rosterEntryId !== "string" ||
        typeof item.assessment !== "string" ||
        typeof item.notes !== "string"
      ) {
        return [];
      }
      const review = item as RosterReview;
      return [[review.rosterEntryId, review] as const];
    }),
  );
}

function contactLabel(contact: {
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
}): string {
  return (
    contact.email ??
    contact.phone ??
    contact.directOutreachNote ??
    "No contact channel"
  );
}

function rosterContactChanged(
  snapshot: {
    snapshotEmail: string | null;
    snapshotPhone: string | null;
    snapshotDirectOutreachNote: string | null;
    snapshotName: string | null;
    snapshotRole: string | null;
    snapshotSource: string | null;
    snapshotNotes: string | null;
    snapshotIsFullTeam: boolean;
  },
  current: {
    email: string | null;
    phone: string | null;
    directOutreachNote: string | null;
    name: string | null;
    role: string | null;
    source: string | null;
    notes: string | null;
    isFullTeam: boolean;
  },
): boolean {
  return (
    snapshot.snapshotEmail !== current.email ||
    snapshot.snapshotPhone !== current.phone ||
    snapshot.snapshotDirectOutreachNote !== current.directOutreachNote ||
    snapshot.snapshotName !== current.name ||
    snapshot.snapshotRole !== current.role ||
    snapshot.snapshotSource !== current.source ||
    snapshot.snapshotNotes !== current.notes ||
    snapshot.snapshotIsFullTeam !== current.isFullTeam
  );
}

function auditHref(
  runId: string,
  page = 1,
  result?: {
    action?: ContactAuditArtistAction;
    error?: string;
  },
): string {
  const params = new URLSearchParams({ run: runId });
  if (page > 1) params.set("page", String(page));
  if (result?.action) params.set("resolved", result.action);
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
      String(formData.get("page") ?? "").trim(),
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
      }),
    );
    error = "Unable to queue the contact audit. Please try again.";
  }
  revalidatePath("/contact-audit");
  const params = new URLSearchParams();
  if (result) params.set("request", result.created ? "queued" : "existing");
  if (error) params.set("requestError", error.slice(0, 300));
  redirect(`/contact-audit?${params.toString()}`);
}

async function saveArtistAuditDecisionAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/contact-audit");
  const context = actionContext(formData);
  const artistId = String(formData.get("artistId") ?? "")
    .trim()
    .slice(0, 100);
  const rawAction = String(formData.get("decisionAction") ?? "").trim();
  const action = CONTACT_AUDIT_ARTIST_ACTIONS.includes(
    rawAction as ContactAuditArtistAction,
  )
    ? (rawAction as ContactAuditArtistAction)
    : null;
  const alternativeId =
    String(formData.get("alternativeId") ?? "").trim().slice(0, 100) || null;
  const selectedContactIds = formData
    .getAll("selectedContactId")
    .flatMap((value) =>
      typeof value === "string" ? [value.trim().slice(0, 100)] : [],
    );
  const result = action
    ? await resolveContactAuditArtist({
        runId: context.runId,
        artistId,
        action,
        alternativeId,
        selectedContactIds,
      })
    : { ok: false as const, error: "Invalid artist audit action." };
  revalidatePath("/contact-audit");
  redirect(
    auditHref(context.runId, context.page, {
      ...(result.ok ? { action: result.action } : {}),
      ...(!result.ok ? { error: result.error } : {}),
    }),
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
  const resolved = CONTACT_AUDIT_ARTIST_ACTIONS.includes(
    rawResolved as ContactAuditArtistAction,
  )
    ? (rawResolved as ContactAuditArtistAction)
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

  const [allJobs, incompleteJobs, statusCounts, decisions] = selectedRun
    ? await Promise.all([
        db.contactAuditJob.findMany({
          where: {
            runId: selectedRun.id,
            status: "complete",
            finding: { in: [...FLAGGED_FINDINGS] },
            resolution: null,
            artistId: { not: null },
          },
          orderBy: [{ verifiedAt: "desc" }, { createdAt: "asc" }],
          include: {
            alternatives: { orderBy: { createdAt: "asc" } },
            rosterSnapshot: {
              include: {
                entries: {
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                },
              },
            },
            artist: { select: { id: true } },
          },
        }),
        db.contactAuditJob.findMany({
          where: {
            runId: selectedRun.id,
            status: { not: "complete" },
            artistId: { not: null },
          },
          select: { artistId: true },
        }),
        db.contactAuditJob.groupBy({
          by: ["status"],
          where: { runId: selectedRun.id },
          _count: { _all: true },
        }),
        db.contactAuditArtistDecision.findMany({
          where: { runId: selectedRun.id },
          select: { artistId: true },
        }),
      ])
    : [[], [], [], []];
  const decidedArtistIds = new Set(decisions.map((decision) => decision.artistId));
  const incompleteArtistIds = new Set(
    incompleteJobs.flatMap((job) => (job.artistId ? [job.artistId] : [])),
  );
  const groupsByArtist = new Map<string, typeof allJobs>();
  for (const job of allJobs) {
    if (
      !job.artistId ||
      decidedArtistIds.has(job.artistId) ||
      incompleteArtistIds.has(job.artistId)
    ) {
      continue;
    }
    const group = groupsByArtist.get(job.artistId) ?? [];
    group.push(job);
    groupsByArtist.set(job.artistId, group);
  }
  const artistGroups = [...groupsByArtist.entries()]
    .map(([artistId, jobs]) => ({
      artistId,
      jobs,
      verifiedAt: jobs.reduce<Date | null>(
        (latest, job) =>
          !latest || (job.verifiedAt && job.verifiedAt > latest)
            ? job.verifiedAt
            : latest,
        null,
      ),
    }))
    .sort(
      (left, right) =>
        (right.verifiedAt?.getTime() ?? 0) -
        (left.verifiedAt?.getTime() ?? 0),
    );
  const pagination = getPagination(
    artistGroups.length,
    requestedPage,
    PAGE_SIZE,
  );
  const pagedGroups = artistGroups.slice(
    (pagination.page - 1) * PAGE_SIZE,
    pagination.page * PAGE_SIZE,
  );
  const rosterContactIds = pagedGroups.flatMap(({ jobs }) =>
    jobs[0]?.rosterSnapshot?.entries.map(
      (entry) => entry.snapshotContactId,
    ) ?? [],
  );
  const currentRosterContacts =
    rosterContactIds.length > 0
      ? await db.contact.findMany({
          where: { id: { in: rosterContactIds } },
          select: {
            id: true,
            email: true,
            phone: true,
            directOutreachNote: true,
            name: true,
            role: true,
            source: true,
            notes: true,
            state: true,
            isFullTeam: true,
          },
        })
      : [];
  const currentRosterContactById = new Map(
    currentRosterContacts.map((contact) => [contact.id, contact]),
  );
  const countByStatus = new Map(
    statusCounts.map((row) => [row.status, row._count._all]),
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Contact audit decisions
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            Each artist appears once with the complete stored roster, all audit
            findings, and every proposed management contact.
          </p>
        </div>
        <div className="mobile-action-grid flex flex-wrap items-center gap-2 sm:w-auto">
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
          Artist decision saved: {resolved.replaceAll("_", " ")}.
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
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
                Last attempt: {latestRequest.lastError}.
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
            No audit has been run yet.
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Artists needing decisions", artistGroups.length],
              ["Queued contacts", countByStatus.get("pending") ?? 0],
              ["Researching contacts", countByStatus.get("claimed") ?? 0],
              ["Completed contacts", countByStatus.get("complete") ?? 0],
            ].map(([label, value]) => (
              <Card key={label}>
                <CardBody className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          {pagedGroups.length === 0 ? (
            <Card className="mt-5">
              <CardBody className="py-10 text-center text-sm text-zinc-500">
                No unresolved artist decisions remain for this run.
              </CardBody>
            </Card>
          ) : (
            <div className="mt-5 space-y-4">
              {pagedGroups.map(({ artistId, jobs }) => {
                const primary = jobs[0];
                const roster = primary.rosterSnapshot;
                const jobByTargetEntry = new Map(
                  jobs.flatMap((job) =>
                    job.targetRosterEntryId
                      ? [[job.targetRosterEntryId, job] as const]
                      : [],
                  ),
                );
                const alternativeByEmail = new Map<
                  string,
                  (typeof jobs)[number]["alternatives"][number]
                >();
                for (const alternative of jobs.flatMap(
                  (job) => job.alternatives,
                )) {
                  if (!alternativeByEmail.has(alternative.normalizedEmail)) {
                    alternativeByEmail.set(
                      alternative.normalizedEmail,
                      alternative,
                    );
                  }
                }
                const alternatives = [...alternativeByEmail.values()];
                const findings = Array.from(
                  new Set(jobs.map((job) => job.finding).filter(Boolean)),
                );
                const activeEntries =
                  roster?.entries.filter(
                    (entry) =>
                      currentRosterContactById.get(entry.snapshotContactId)
                        ?.state === "active",
                  ) ?? [];
                const staleEntries = activeEntries.filter(
                  (entry) =>
                  jobByTargetEntry.get(entry.id)?.finding === "stale",
                );
                return (
                  <Card key={artistId}>
                    <CardBody>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        {primary.artist ? (
                          <Link
                            href={`/artists/${primary.artist.id}`}
                            className="text-lg font-medium hover:underline"
                          >
                            {primary.snapshotArtistName}
                          </Link>
                        ) : (
                          <p className="text-lg font-medium">
                            {primary.snapshotArtistName}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {findings.map((finding) => (
                            <Badge key={finding} tone={findingTone(finding)}>
                              {finding}
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="mt-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                            Complete artist contact roster
                          </h2>
                          <Badge tone="info">
                            {roster?.entries.length ?? 0} stored
                          </Badge>
                        </div>
                        {!roster ? (
                          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                            This legacy audit has no complete artist snapshot.
                            Queue a new audit before deciding it.
                          </p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {roster.entries.map((entry) => {
                              const current = currentRosterContactById.get(
                                entry.snapshotContactId,
                              );
                              const targetJob = jobByTargetEntry.get(entry.id);
                              const review = targetJob
                                ? rosterReviews(targetJob.rosterReview).get(
                                    entry.id,
                                  )
                                : null;
                              return (
                                <div
                                  key={entry.id}
                                  className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="break-all text-sm font-medium">
                                      {entry.snapshotName
                                        ? `${entry.snapshotName} · `
                                        : ""}
                                      {contactLabel({
                                        email: entry.snapshotEmail,
                                        phone: entry.snapshotPhone,
                                        directOutreachNote:
                                          entry.snapshotDirectOutreachNote,
                                      })}
                                    </span>
                                    {targetJob?.finding && (
                                      <Badge
                                        tone={findingTone(targetJob.finding)}
                                      >
                                        {targetJob.finding}
                                      </Badge>
                                    )}
                                    {review && (
                                      <Badge tone="muted">
                                        Agent: {review.assessment}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="mt-1 text-xs text-zinc-500">
                                    Role: {entry.snapshotRole ?? "not recorded"}
                                    {entry.snapshotSource
                                      ? ` · source: ${entry.snapshotSource}`
                                      : ""}
                                    {current
                                      ? ` · current status: ${current.state}${
                                          rosterContactChanged(entry, current)
                                            ? " (changed since snapshot)"
                                            : ""
                                        }`
                                      : " · current status: deleted"}
                                  </p>
                                  {review && (
                                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                                      {review.notes}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <details className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                        <summary className="cursor-pointer text-sm font-medium">
                          Audit evidence for {jobs.length} contact
                          {jobs.length === 1 ? "" : "s"}
                        </summary>
                        <div className="mt-3 space-y-3">
                          {jobs.map((job) => (
                            <div key={job.id}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">
                                  {contactLabel({
                                    email: job.snapshotEmail,
                                    phone: job.snapshotPhone,
                                    directOutreachNote:
                                      job.snapshotDirectOutreachNote,
                                  })}
                                </span>
                                <Badge tone={findingTone(job.finding)}>
                                  {job.finding}
                                </Badge>
                                {job.confidence && (
                                  <Badge tone="muted">{job.confidence}</Badge>
                                )}
                              </div>
                              {job.evidence && (
                                <p className="mt-1 text-sm">{job.evidence}</p>
                              )}
                              <div className="mt-1 flex flex-wrap gap-3">
                                {job.sourceUrls.map((url, index) => (
                                  <a
                                    key={url}
                                    href={url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-700 hover:underline dark:text-blue-300"
                                  >
                                    Source {index + 1} ↗
                                  </a>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>

                      {alternatives.length > 0 && roster && (
                        <div className="mt-4 space-y-3">
                          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                            Proposed manager contacts
                          </h2>
                          {alternatives.map((alternative) => (
                            <div
                              key={alternative.id}
                              className="rounded-lg border border-emerald-200 p-3 dark:border-emerald-900"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="break-all font-medium">
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

                              <form
                                action={saveArtistAuditDecisionAction}
                                className="mt-3"
                              >
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
                                <input
                                  type="hidden"
                                  name="artistId"
                                  value={artistId}
                                />
                                <input
                                  type="hidden"
                                  name="alternativeId"
                                  value={alternative.id}
                                />
                                <input
                                  type="hidden"
                                  name="decisionAction"
                                  value="append"
                                />
                                <PendingSubmitButton
                                  size="sm"
                                  pendingLabel="Adding contact…"
                                  className="w-full sm:w-auto"
                                >
                                  Add contact and keep all existing
                                </PendingSubmitButton>
                              </form>

                              <form
                                action={saveArtistAuditDecisionAction}
                                className="mt-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
                              >
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
                                <input
                                  type="hidden"
                                  name="artistId"
                                  value={artistId}
                                />
                                <input
                                  type="hidden"
                                  name="alternativeId"
                                  value={alternative.id}
                                />
                                <input
                                  type="hidden"
                                  name="decisionAction"
                                  value="replace_selected"
                                />
                                <p className="text-xs font-medium">
                                  Replace selected contacts
                                </p>
                                <div className="mt-2 space-y-2">
                                  {activeEntries.map((entry) => (
                                    <label
                                      key={entry.id}
                                      className="flex min-h-10 items-center gap-2 text-sm"
                                    >
                                      <input
                                        type="checkbox"
                                        name="selectedContactId"
                                        value={entry.snapshotContactId}
                                        defaultChecked={
                                          jobByTargetEntry.get(entry.id)
                                            ?.finding === "stale"
                                        }
                                        className="h-4 w-4"
                                      />
                                      <span className="break-all">
                                        {contactLabel({
                                          email: entry.snapshotEmail,
                                          phone: entry.snapshotPhone,
                                          directOutreachNote:
                                            entry.snapshotDirectOutreachNote,
                                        })}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                                <PendingSubmitButton
                                  size="sm"
                                  variant="danger"
                                  pendingLabel="Replacing contacts…"
                                  className="mt-3 w-full sm:w-auto"
                                >
                                  Add new and deactivate selected
                                </PendingSubmitButton>
                              </form>
                            </div>
                          ))}
                        </div>
                      )}

                      {roster && staleEntries.length > 0 && (
                          <form
                            action={saveArtistAuditDecisionAction}
                            className="mt-4 rounded-lg border border-red-200 p-3 dark:border-red-900"
                          >
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
                            <input
                              type="hidden"
                              name="artistId"
                              value={artistId}
                            />
                            <input
                              type="hidden"
                              name="decisionAction"
                              value="deactivate_selected"
                            />
                            <p className="text-xs font-medium">
                              Deactivate selected stale contacts
                            </p>
                            <div className="mt-2 space-y-2">
                              {staleEntries.map((entry) => (
                                <label
                                  key={entry.id}
                                  className="flex min-h-10 items-center gap-2 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    name="selectedContactId"
                                    value={entry.snapshotContactId}
                                    defaultChecked={
                                      jobByTargetEntry.get(entry.id)?.finding ===
                                      "stale"
                                    }
                                    className="h-4 w-4"
                                  />
                                  {contactLabel({
                                    email: entry.snapshotEmail,
                                    phone: entry.snapshotPhone,
                                    directOutreachNote:
                                      entry.snapshotDirectOutreachNote,
                                  })}
                                </label>
                              ))}
                            </div>
                            <PendingSubmitButton
                              variant="danger"
                              size="sm"
                              pendingLabel="Deactivating contacts…"
                              className="mt-3 w-full sm:w-auto"
                            >
                              Deactivate selected
                            </PendingSubmitButton>
                          </form>
                        )}

                      <form
                        action={saveArtistAuditDecisionAction}
                        className="mt-4"
                      >
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
                        <input
                          type="hidden"
                          name="artistId"
                          value={artistId}
                        />
                        <input
                          type="hidden"
                          name="decisionAction"
                          value="rejected"
                        />
                        <PendingSubmitButton
                          variant="secondary"
                          size="sm"
                          pendingLabel="Rejecting change…"
                          className="w-full sm:w-auto"
                        >
                          Reject proposed change — keep all contacts
                        </PendingSubmitButton>
                      </form>
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          )}

          {pagination.pageCount > 1 && (
            <nav
              aria-label="Contact audit pages"
              className="mt-6 flex items-center justify-between gap-3"
            >
              {pagination.hasPrevious ? (
                <Link href={auditHref(selectedRun.id, pagination.page - 1)}>
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-xs text-zinc-500">
                Page {pagination.page} of {pagination.pageCount}
              </span>
              {pagination.hasNext ? (
                <Link href={auditHref(selectedRun.id, pagination.page + 1)}>
                  Next →
                </Link>
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
