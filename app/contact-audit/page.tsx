import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireServerActionAuth } from "@/lib/auth";
import { markContactAuditReviewed } from "@/lib/contactAudit";
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
type AuditView = "flagged" | "unreviewed" | "all";

function formatTimestamp(value: Date | null): string {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(value);
}

function findingTone(finding: string | null): BadgeTone {
  if (finding === "current") return "success";
  if (finding === "changed" || finding === "ambiguous") return "warning";
  if (finding === "stale") return "danger";
  if (finding === "unverified") return "muted";
  return "info";
}

function auditHref(runId: string, view: AuditView, page = 1): string {
  const params = new URLSearchParams({ run: runId, view });
  if (page > 1) params.set("page", String(page));
  return `/contact-audit?${params.toString()}`;
}

async function markReviewedAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/contact-audit");
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (jobId) await markContactAuditReviewed(jobId);
  revalidatePath("/contact-audit");
}

export default async function ContactAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    run?: SearchParamValue;
    view?: SearchParamValue;
    page?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const requestedRunId = firstSearchParam(raw.run)?.slice(0, 100) ?? null;
  const requestedView = firstSearchParam(raw.view);
  const view: AuditView =
    requestedView === "all" || requestedView === "unreviewed"
      ? requestedView
      : "flagged";
  const requestedPage = positiveIntegerSearchParam(raw.page);
  const runs = await db.contactAuditRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { _count: { select: { jobs: true } } },
  });
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
        ...(view === "flagged"
          ? { finding: { in: ["changed", "stale", "ambiguous"] } }
          : view === "unreviewed"
            ? { status: "complete", reviewedAt: null }
            : {}),
      }
    : { id: "__no_contact_audit_run__" };
  const [
    total,
    statusCounts,
    flaggedCount,
    unreviewedCount,
  ] = selectedRun
    ? await Promise.all([
        db.contactAuditJob.count({ where }),
        db.contactAuditJob.groupBy({
          by: ["status"],
          where: { runId: selectedRun.id },
          _count: { _all: true },
        }),
        db.contactAuditJob.count({
          where: {
            runId: selectedRun.id,
            finding: { in: ["changed", "stale", "ambiguous"] },
          },
        }),
        db.contactAuditJob.count({
          where: {
            runId: selectedRun.id,
            status: "complete",
            reviewedAt: null,
          },
        }),
      ])
    : [0, [], 0, 0];
  const pagination = getPagination(total, requestedPage, PAGE_SIZE);
  const jobs = selectedRun
    ? await db.contactAuditJob.findMany({
        where,
        orderBy: [
          { reviewedAt: "asc" },
          { verifiedAt: "desc" },
          { createdAt: "asc" },
        ],
        skip: (pagination.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          alternatives: { orderBy: { createdAt: "asc" } },
          contact: { select: { id: true, state: true } },
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
            Contact audit
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Agents verify active manager contacts against current public
            sources. Findings are review-only and never change contact records.
          </p>
        </div>
        <LinkButton
          href={WORKFLOW_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Run contact audit ↗
        </LinkButton>
      </div>

      <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
        Running the GitHub workflow snapshots every active contact. Review
        findings here; edit a contact separately only after checking the saved
        evidence.
      </div>

      {runs.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2" aria-label="Audit runs">
          {runs.map((run, index) => (
            <LinkButton
              key={run.id}
              href={auditHref(run.id, view)}
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
            No audit has been run yet. Start the manual GitHub workflow to
            snapshot and verify every active contact.
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ["Flagged", flaggedCount],
              ["Unreviewed", unreviewedCount],
              ["Queued", countByStatus.get("pending") ?? 0],
              ["Researching", countByStatus.get("claimed") ?? 0],
              ["Complete", countByStatus.get("complete") ?? 0],
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
            <div className="flex gap-2">
              {(
                [
                  ["flagged", `Flagged (${flaggedCount})`],
                  ["unreviewed", `Unreviewed (${unreviewedCount})`],
                  ["all", `All (${selectedRun.contactCount})`],
                ] as const
              ).map(([value, label]) => (
                <LinkButton
                  key={value}
                  href={auditHref(selectedRun.id, value)}
                  variant={view === value ? "primary" : "secondary"}
                  size="sm"
                >
                  {label}
                </LinkButton>
              ))}
            </div>
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
                No contacts match this view.
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
                        <p className="mt-1 break-all text-xs text-zinc-500">
                          {job.snapshotName
                            ? `${job.snapshotName} · `
                            : ""}
                          {job.snapshotEmail ??
                            job.snapshotPhone ??
                            "No email or phone"}
                          {job.snapshotRole ? ` · ${job.snapshotRole}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {job.finding && (
                          <Badge tone={findingTone(job.finding)}>
                            {job.finding}
                          </Badge>
                        )}
                        {job.confidence && (
                          <Badge tone="muted">{job.confidence}</Badge>
                        )}
                        {job.reviewedAt && (
                          <Badge tone="success">reviewed</Badge>
                        )}
                        {!job.finding && (
                          <Badge tone="info">{job.status}</Badge>
                        )}
                      </div>
                    </div>

                    {job.evidence && (
                      <p className="mt-3 text-sm">{job.evidence}</p>
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

                    {job.alternatives.length > 0 && (
                      <div className="mt-4">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Plausible current manager contacts
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
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.status === "complete" && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {!job.reviewedAt && (
                          <form action={markReviewedAction}>
                            <input
                              type="hidden"
                              name="jobId"
                              value={job.id}
                            />
                            <PendingSubmitButton
                              size="sm"
                              pendingLabel="Marking…"
                            >
                              Mark reviewed
                            </PendingSubmitButton>
                          </form>
                        )}
                        {job.contact?.state === "active" && (
                          <LinkButton
                            href={`/dashboard/contact/${job.contact.id}`}
                            variant="secondary"
                            size="sm"
                          >
                            Open contact
                          </LinkButton>
                        )}
                      </div>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}

          {pagination.pageCount > 1 && (
            <nav
              aria-label="Contact audit pages"
              className="mt-5 flex items-center justify-between gap-3"
            >
              {pagination.hasPrevious ? (
                <LinkButton
                  href={auditHref(
                    selectedRun.id,
                    view,
                    pagination.page - 1
                  )}
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
                  href={auditHref(
                    selectedRun.id,
                    view,
                    pagination.page + 1
                  )}
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
