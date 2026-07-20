import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  approveContactResearchCandidate,
  refreshContactResearchQueue,
  rejectContactResearchCandidate,
  retryAllContactResearchJobs,
  retryContactResearchJob,
  updateContactResearchJobUserNotes,
} from "@/lib/contactResearch";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { formatShowDate } from "@/lib/formatDate";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { TextArea } from "@/components/ui/field";
import { AutoDismissStatus } from "./auto-dismiss-status";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact research" };

function researchHref(values: Record<string, string>): string {
  const params = new URLSearchParams(values);
  return `/research?${params.toString()}`;
}

async function refreshQueueAction() {
  "use server";
  await requireServerActionAuth("/research");
  let destination: string;
  try {
    const result = await refreshContactResearchQueue();
    destination = researchHref({
      refreshed: "1",
      eligible: String(result.eligible),
      enqueued: String(result.enqueued),
    });
  } catch (error) {
    destination = researchHref({
      error: "queue_refresh",
      detail: (error instanceof Error ? error.message : String(error)).slice(
        0,
        180
      ),
    });
  }
  revalidatePath("/research");
  revalidatePath("/settings");
  redirect(destination);
}

async function approveCandidateAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/research");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) {
    redirect(researchHref({ error: "missing_candidate" }));
  }
  const result = await approveContactResearchCandidate(candidateId);
  revalidatePath("/research");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/settings/contacts");
  if (!result.ok) {
    redirect(
      researchHref({
        error: "approve_failed",
        detail: result.error ?? "Candidate could not be approved",
      })
    );
  }
  if (result.sheetError) {
    redirect(researchHref({ sheet_error: result.sheetError }));
  }
}

async function rejectCandidateAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/research");
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) {
    redirect(researchHref({ error: "missing_candidate" }));
  }
  const result = await rejectContactResearchCandidate(candidateId);
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!result.ok) redirect(researchHref({ error: "reject_failed" }));
}

async function retryJobAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/research");
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) redirect(researchHref({ error: "missing_job" }));
  const retried = await retryContactResearchJob(jobId);
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!retried) redirect(researchHref({ error: "retry_failed" }));
}

async function saveResearchNotesAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/research");
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) redirect(researchHref({ error: "missing_job" }));
  let updated = false;
  try {
    updated = await updateContactResearchJobUserNotes(
      jobId,
      formData.get("userNotes")
    );
  } catch (error) {
    redirect(
      researchHref({
        error: "notes_failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          180
        ),
      })
    );
  }
  revalidatePath("/research");
  if (!updated) redirect(researchHref({ error: "notes_failed" }));
}

async function retryAllJobsAction() {
  "use server";
  await requireServerActionAuth("/research");
  await retryAllContactResearchJobs();
  revalidatePath("/research");
  revalidatePath("/settings");
}

function statusTone(status: string): BadgeTone {
  if (status === "review") return "warning";
  if (status === "claimed") return "info";
  if (status === "pending") return "accent";
  if (status === "exhausted") return "muted";
  return "default";
}

function confidenceTone(confidence: string): BadgeTone {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "warning";
  return "muted";
}

const STATUS_ORDER = new Map([
  ["review", 0],
  ["claimed", 1],
  ["pending", 2],
  ["exhausted", 3],
]);

export default async function ContactResearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    refreshed?: SearchParamValue;
    eligible?: SearchParamValue;
    enqueued?: SearchParamValue;
    approved?: SearchParamValue;
    rejected?: SearchParamValue;
    retried?: SearchParamValue;
    notes_saved?: SearchParamValue;
    error?: SearchParamValue;
    detail?: SearchParamValue;
    sheet_error?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const status = {
    refreshed: firstSearchParam(raw.refreshed),
    eligible: firstSearchParam(raw.eligible),
    enqueued: firstSearchParam(raw.enqueued),
    approved: firstSearchParam(raw.approved),
    rejected: firstSearchParam(raw.rejected),
    retried: firstSearchParam(raw.retried),
    notesSaved: firstSearchParam(raw.notes_saved),
    error: firstSearchParam(raw.error),
    detail: firstSearchParam(raw.detail),
    sheetError: firstSearchParam(raw.sheet_error),
  };
  const [groupedCounts, activeRows, exhaustedRows] = await Promise.all([
    db.contactResearchJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.contactResearchJob.findMany({
      where: {
        status: { in: ["pending", "claimed", "review"] },
      },
      orderBy: [
        { priority: "desc" },
        { nextShowAt: "asc" },
        { createdAt: "asc" },
      ],
      take: 100,
      include: {
        artist: {
          select: {
            id: true,
            name: true,
            popularity: true,
          },
        },
        candidates: {
          orderBy: [
            { status: "asc" },
            { createdAt: "asc" },
          ],
        },
      },
    }),
    db.contactResearchJob.findMany({
      where: { status: "exhausted" },
      orderBy: [{ updatedAt: "desc" }],
      take: 25,
      include: {
        artist: {
          select: {
            id: true,
            name: true,
            popularity: true,
          },
        },
        candidates: {
          orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        },
      },
    }),
  ]);
  const counts = new Map(
    groupedCounts.map((row) => [row.status, row._count._all])
  );
  const jobs = [...activeRows, ...exhaustedRows].sort((a, b) => {
    const statusDifference =
      (STATUS_ORDER.get(a.status) ?? 99) - (STATUS_ORDER.get(b.status) ?? 99);
    if (statusDifference !== 0) return statusDifference;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (a.nextShowAt?.getTime() ?? Infinity) -
      (b.nextShowAt?.getTime() ?? Infinity);
  });
  const activeCount =
    (counts.get("pending") ?? 0) +
    (counts.get("claimed") ?? 0) +
    (counts.get("review") ?? 0);
  const retryAllCount =
    (counts.get("review") ?? 0) +
    (counts.get("exhausted") ?? 0);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Contact research
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Agents propose manager contacts only. Nothing is added or sent until
            you approve it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={retryAllJobsAction}>
            <PendingSubmitButton
              variant="secondary"
              pendingLabel="Requeueing…"
              disabled={retryAllCount === 0}
            >
              Requeue all review/exhausted ({retryAllCount})
            </PendingSubmitButton>
          </form>
          <form action={refreshQueueAction}>
            <PendingSubmitButton
              variant="secondary"
              pendingLabel="Refreshing…"
            >
              Refresh queue
            </PendingSubmitButton>
          </form>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["To review", counts.get("review") ?? 0],
          ["Researching", counts.get("claimed") ?? 0],
          ["Queued", counts.get("pending") ?? 0],
          ["Exhausted", counts.get("exhausted") ?? 0],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardBody className="p-4">
              <p className="text-xs text-zinc-500">{label}</p>
              <p className="mt-1 text-xl font-semibold">{value}</p>
            </CardBody>
          </Card>
        ))}
      </div>

      {status.refreshed && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Queue refreshed: {status.eligible ?? "0"} eligible ·{" "}
            {status.enqueued ?? "0"} newly queued.
          </div>
        </AutoDismissStatus>
      )}
      {status.approved && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Contact approved.
          </div>
        </AutoDismissStatus>
      )}
      {(status.rejected || status.retried) && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            {status.retried ? "Research queued again." : "Candidate rejected."}
          </div>
        </AutoDismissStatus>
      )}
      {status.notesSaved && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Research instructions saved.
          </div>
        </AutoDismissStatus>
      )}
      {status.sheetError && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {status.sheetError}
          </div>
        </AutoDismissStatus>
      )}
      {status.error && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {status.detail ?? status.error}
          </div>
        </AutoDismissStatus>
      )}

      {!process.env.CONTACT_RESEARCH_AGENT_TOKEN &&
        !process.env.CRON_SECRET && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Set <code>CRON_SECRET</code> or{" "}
          <code>CONTACT_RESEARCH_AGENT_TOKEN</code> before running the worker.
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>{activeCount} active jobs</span>
        <span>
          Run locally with <code>npm run contact-research:agent</code>
        </span>
      </div>

      {jobs.length === 0 ? (
        <Card className="mt-3">
          <CardBody className="py-12 text-center text-sm text-zinc-500">
            No contact research jobs. Refresh after show and listen syncs.
          </CardBody>
        </Card>
      ) : (
        <div className="mt-3 space-y-3">
          {jobs.map((job) => {
            const candidates = job.candidates.filter(
              (candidate) => candidate.status === "pending"
            );
            return (
              <Card key={job.id} id={`job-${job.id}`}>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <Link
                        href={`/artists/${job.artist.id}`}
                        className="font-medium hover:underline"
                      >
                        {job.artist.name}
                      </Link>
                      <p className="mt-1 text-xs text-zinc-500">
                        {job.nextShowAt
                          ? `Next show ${formatShowDate(job.nextShowAt, {})}`
                          : "No upcoming show date"}
                        {job.artist.popularity != null
                          ? ` · popularity ${job.artist.popularity}`
                          : ""}
                        {` · priority ${job.priority}`}
                      </p>
                    </div>
                    <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                  </div>

                  {job.agentNotes && (
                    <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                      {job.agentNotes}
                    </p>
                  )}

                  <form action={saveResearchNotesAction} className="mt-3">
                    <input type="hidden" name="jobId" value={job.id} />
                    <TextArea
                      name="userNotes"
                      label="Research instructions"
                      description="Trusted context for the research agent. Say “skip this artist” or “do not research” to stop without browsing."
                      rows={2}
                      defaultValue={job.userNotes ?? ""}
                      placeholder="Example: Skip this artist — I already know the team personally."
                    />
                    <PendingSubmitButton
                      variant="secondary"
                      size="sm"
                      pendingLabel="Saving…"
                      className="mt-2"
                    >
                      Save instructions
                    </PendingSubmitButton>
                  </form>

                  {candidates.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {candidates.map((candidate) => (
                        <div
                          key={candidate.id}
                          className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all text-sm font-medium">
                              {candidate.email}
                            </span>
                            <Badge tone={confidenceTone(candidate.confidence)}>
                              {candidate.confidence}
                            </Badge>
                          </div>
                          {candidate.name && (
                            <p className="mt-1 text-xs text-zinc-500">
                              {candidate.name}
                            </p>
                          )}
                          <p className="mt-2 text-sm">{candidate.evidence}</p>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                            {candidate.sourceUrls.map((url, index) => (
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="break-all text-xs text-blue-700 hover:underline dark:text-blue-300"
                              >
                                Source {index + 1} ↗
                              </a>
                            ))}
                          </div>
                          <div className="mt-3 flex gap-2">
                            <form action={approveCandidateAction}>
                              <input
                                type="hidden"
                                name="candidateId"
                                value={candidate.id}
                              />
                              <PendingSubmitButton
                                size="sm"
                                pendingLabel="Approving…"
                              >
                                Approve
                              </PendingSubmitButton>
                            </form>
                            <form action={rejectCandidateAction}>
                              <input
                                type="hidden"
                                name="candidateId"
                                value={candidate.id}
                              />
                              <PendingSubmitButton
                                variant="secondary"
                                size="sm"
                                pendingLabel="Rejecting…"
                              >
                                Reject
                              </PendingSubmitButton>
                            </form>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {(job.status === "exhausted" ||
                    job.status === "review") && (
                    <form action={retryJobAction} className="mt-3">
                      <input type="hidden" name="jobId" value={job.id} />
                      <PendingSubmitButton
                        variant="secondary"
                        size="sm"
                        pendingLabel="Queueing…"
                      >
                        Requeue research
                      </PendingSubmitButton>
                    </form>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
