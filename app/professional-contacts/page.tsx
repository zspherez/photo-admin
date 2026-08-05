import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireServerActionAuth } from "@/lib/auth";
import {
  createProfessionalContactRequest,
  decideProfessionalContactCandidate,
  dispatchProfessionalContactRequest,
  PROFESSIONAL_CONTACT_WORKFLOW_REF,
  requeueProfessionalContactJob,
} from "@/lib/professionalContactResearch";
import { workflowActionsUrl } from "@/lib/appConfig";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { ProfessionalContactRequestForm } from "@/components/professional-contact-request-form";
import { CopyProfessionalEmailButton } from "@/components/copy-professional-email-button";
import { ProfessionalContactAutoRefresh } from "@/components/professional-contact-auto-refresh";
import {
  firstSearchParam,
  type SearchParamValue,
} from "@/lib/searchParams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Professional contact finder" };

const FILTERS = [
  "all",
  "pending",
  "running",
  "review",
  "exhausted",
  "completed",
] as const;
type Filter = (typeof FILTERS)[number];

function parseFilter(value: unknown): Filter {
  return typeof value === "string" && FILTERS.includes(value as Filter)
    ? (value as Filter)
    : "all";
}

function statusTone(status: string): BadgeTone {
  if (status === "review") return "warning";
  if (status === "claimed") return "info";
  if (status === "pending") return "accent";
  if (status === "completed") return "success";
  return "muted";
}

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function displayedPatternExamples(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof Reflect.get(entry, "email") !== "string" ||
      typeof Reflect.get(entry, "personName") !== "string"
    ) {
      return [];
    }
    return [{
      email: String(Reflect.get(entry, "email")),
      personName: String(Reflect.get(entry, "personName")),
    }];
  });
}

async function createRequestAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/professional-contacts");
  let result;
  try {
    result = await createProfessionalContactRequest({
      organizationName: formValue(formData, "organizationName"),
      website: formValue(formData, "website"),
      locationContext: formValue(formData, "locationContext"),
      notes: formValue(formData, "notes"),
      personNames: formValue(formData, "personNames"),
    });
  } catch (error) {
    redirect(
      `/professional-contacts?error=${encodeURIComponent(
        (error instanceof Error ? error.message : String(error)).slice(0, 240),
      )}`,
    );
  }
  let dispatch;
  try {
    dispatch = await dispatchProfessionalContactRequest(result.requestId, {
      mode: "submit",
    });
  } catch (error) {
    dispatch = {
      state: "failed",
      error: (error instanceof Error ? error.message : String(error)).slice(
        0,
        240,
      ),
    };
  }
  revalidatePath("/professional-contacts");
  redirect(
    `/professional-contacts?request=${encodeURIComponent(
      result.requestId,
    )}&queued=${result.jobCount}&duplicate=${
      result.duplicate ? "1" : "0"
    }&dispatch=${encodeURIComponent(dispatch.state)}#request-${encodeURIComponent(
      result.requestId,
    )}`,
  );
}

async function decideCandidateAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/professional-contacts");
  const candidateId = formValue(formData, "candidateId").trim();
  const action = formValue(formData, "action");
  if (!candidateId || (action !== "approved" && action !== "rejected")) {
    redirect("/professional-contacts?error=Invalid%20decision");
  }
  const result = await decideProfessionalContactCandidate(candidateId, action);
  revalidatePath("/professional-contacts");
  if (!result.ok) {
    redirect(
      `/professional-contacts?error=${encodeURIComponent(
        result.error ?? "Decision could not be saved",
      )}`,
    );
  }
}

async function requeueJobAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/professional-contacts");
  const jobId = formValue(formData, "jobId").trim();
  const job = jobId
    ? await db.professionalContactJob.findUnique({
        where: { id: jobId },
        select: {
          requestId: true,
          request: {
            select: {
              dispatch: { select: { updatedAt: true } },
            },
          },
        },
      })
    : null;
  if (!job || !(await requeueProfessionalContactJob(jobId))) {
    redirect("/professional-contacts?error=Job%20is%20not%20eligible%20for%20requeue");
  }
  let dispatch: { state: string };
  try {
    dispatch = job.request.dispatch
      ? await dispatchProfessionalContactRequest(job.requestId, {
          mode: "retry",
          expectedUpdatedAt: job.request.dispatch.updatedAt,
        })
      : { state: "failed" };
  } catch {
    dispatch = { state: "failed" };
  }
  revalidatePath("/professional-contacts");
  redirect(
    `/professional-contacts?request=${encodeURIComponent(
      job.requestId,
    )}&dispatch=${encodeURIComponent(dispatch.state)}#request-${encodeURIComponent(
      job.requestId,
    )}`,
  );
}

async function retryDispatchAction(formData: FormData) {
  "use server";
  await requireServerActionAuth("/professional-contacts");
  const requestId = formValue(formData, "requestId").trim();
  const expected = new Date(formValue(formData, "dispatchUpdatedAt"));
  if (!requestId || Number.isNaN(expected.getTime())) {
    redirect("/professional-contacts?error=Invalid%20dispatch%20retry");
  }
  let dispatch: { state: string };
  try {
    dispatch = await dispatchProfessionalContactRequest(requestId, {
      mode: "retry",
      expectedUpdatedAt: expected,
    });
  } catch {
    dispatch = { state: "failed" };
  }
  revalidatePath("/professional-contacts");
  redirect(
    `/professional-contacts?request=${encodeURIComponent(
      requestId,
    )}&dispatch=${encodeURIComponent(dispatch.state)}#request-${encodeURIComponent(
      requestId,
    )}`,
  );
}

export default async function ProfessionalContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: SearchParamValue;
    queued?: SearchParamValue;
    duplicate?: SearchParamValue;
    dispatch?: SearchParamValue;
    request?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const query = await searchParams;
  const filter = parseFilter(firstSearchParam(query.status));
  const queued = firstSearchParam(query.queued);
  const duplicate = firstSearchParam(query.duplicate);
  const error = firstSearchParam(query.error);
  const dispatchNotice = firstSearchParam(query.dispatch);
  const selectedRequestId = firstSearchParam(query.request);
  const now = new Date();
  const statusWhere =
    filter === "all"
      ? undefined
      : filter === "running"
        ? "claimed"
        : filter;
  const [jobs, groupedCounts] = await Promise.all([
    db.professionalContactJob.findMany({
      where: statusWhere ? { status: statusWhere } : undefined,
      orderBy: [{ createdAt: "desc" }],
      take: 150,
      select: {
        id: true,
        personName: true,
        status: true,
        attemptCount: true,
        claimedAt: true,
        claimExpiresAt: true,
        agentNotes: true,
        completedAt: true,
        createdAt: true,
        request: {
          select: {
            id: true,
            organizationName: true,
            website: true,
            locationContext: true,
            notes: true,
            personNames: true,
            createdAt: true,
            dispatch: {
              select: {
                status: true,
                attemptCount: true,
                leaseExpiresAt: true,
                lastAttemptAt: true,
                lastDispatchedAt: true,
                lastError: true,
                updatedAt: true,
              },
            },
          },
        },
        candidates: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            email: true,
            personName: true,
            roleTitle: true,
            organization: true,
            confidence: true,
            discoveryMethod: true,
            evidence: true,
            sourceUrls: true,
            patternEvidence: true,
            patternEvidenceUrl: true,
            patternExamples: true,
            createdAt: true,
            decision: {
              select: { action: true, decidedAt: true },
            },
          },
        },
      },
    }),
    db.professionalContactJob.groupBy({
      by: ["status"],
      _count: true,
    }),
  ]);
  const counts = new Map(
    groupedCounts.map((entry) => [
      entry.status === "claimed" ? "running" : entry.status,
      entry._count,
    ]),
  );
  const workflowUrl = workflowActionsUrl(PROFESSIONAL_CONTACT_WORKFLOW_REF);
  const selectedDispatch = jobs.find(
    (job) => job.request.id === selectedRequestId,
  )?.request.dispatch;
  const hasActiveJobs = jobs.some(
    (job) => job.status === "pending" || job.status === "claimed",
  );

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <ProfessionalContactAutoRefresh enabled={hasActiveJobs} />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-zinc-500">Research / standalone people</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Professional contact finder
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
            Research public professional or business email addresses for named
            people at any organization. Every result requires human review and
            never creates artist contacts or sends outreach.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/research" variant="secondary" size="sm">
            Artist manager research
          </LinkButton>
          <LinkButton
            href={workflowUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            size="sm"
          >
            Open finder workflow
          </LinkButton>
        </div>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </p>
      )}
      {queued && (
        <div
          role={dispatchNotice === "failed" ? "alert" : "status"}
          className={`rounded-md border p-3 text-sm ${
            dispatchNotice === "failed"
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
              : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
          }`}
        >
          <p>
            {duplicate === "1"
              ? `This exact scope was already saved (${queued} people); no duplicate jobs were created.`
              : `Saved and queued ${queued} people for professional contact research.`}
          </p>
          <p className="mt-1">
            {dispatchNotice === "dispatched"
              ? "The trusted worker trigger was accepted. Jobs will show running as soon as they are claimed."
              : dispatchNotice === "in_progress"
                ? "The trusted worker is already being started."
                : dispatchNotice === "already_dispatched"
                  ? "The existing request already has a worker trigger; it was not dispatched twice."
                  : dispatchNotice === "failed"
                    ? `The durable jobs are safe, but the worker trigger failed${
                        selectedDispatch?.lastError
                          ? `: ${selectedDispatch.lastError}`
                          : "."
                      } Retry the worker trigger below.`
                    : "The durable request is visible below."}
          </p>
        </div>
      )}
      {dispatchNotice && !queued && (
        <div
          role={dispatchNotice === "failed" ? "alert" : "status"}
          className={`rounded-md border p-3 text-sm ${
            dispatchNotice === "failed"
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
              : "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200"
          }`}
        >
          {dispatchNotice === "dispatched"
            ? "The trusted worker trigger was accepted again."
            : dispatchNotice === "in_progress"
              ? "A worker trigger is already in progress; no duplicate trigger was sent."
              : dispatchNotice === "stale"
                ? "The trigger state changed before this action completed; refresh before retrying."
                : dispatchNotice === "no_work"
                  ? "No queued work currently needs another worker trigger."
                  : `The durable jobs remain queued, but the worker trigger failed${
                      selectedDispatch?.lastError
                        ? `: ${selectedDispatch.lastError}`
                        : "."
                    }`}
        </div>
      )}

      <Card>
        <CardBody>
          <h2 className="text-lg font-semibold">New research request</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Official organization/team/contact sources come first. Private,
            home, personal, generic, or unverifiable addresses are out of scope.
          </p>
          <div className="mt-5">
            <ProfessionalContactRequestForm action={createRequestAction} />
          </div>
        </CardBody>
      </Card>

      <section id="queue" className="space-y-4 scroll-mt-20">
        <div>
          <h2 className="text-lg font-semibold">Queue and results</h2>
          <p className="text-sm text-zinc-500">
            Attempts, claim leases, exhaustion, evidence, and immutable human
            decisions remain visible.
          </p>
        </div>
        <nav
          aria-label="Filter professional contact jobs by status"
          className="flex flex-wrap gap-2"
        >
          {FILTERS.map((status) => {
            const active = filter === status;
            const count =
              status === "all"
                ? groupedCounts.reduce((sum, entry) => sum + entry._count, 0)
                : counts.get(status) ?? 0;
            return (
              <Link
                key={status}
                href={
                  status === "all"
                    ? "/professional-contacts#queue"
                    : `/professional-contacts?status=${status}#queue`
                }
                aria-current={active ? "page" : undefined}
                className={`rounded-md border px-3 py-2 text-sm capitalize ${
                  active
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                }`}
              >
                {status} ({count})
              </Link>
            );
          })}
        </nav>

        {jobs.length === 0 ? (
          <Card>
            <CardBody className="text-sm text-zinc-500">
              No jobs match this status.
            </CardBody>
          </Card>
        ) : (
          jobs.map((job) => {
            const decisions = job.candidates.map((candidate) => candidate.decision);
            const hasApproval = decisions.some(
              (decision) => decision?.action === "approved",
            );
            const canRequeue =
              job.status === "exhausted" ||
              (job.status === "completed" && !hasApproval);
            return (
              <Card
                key={job.id}
                id={`request-${job.request.id}`}
                className={
                  job.request.id === selectedRequestId
                    ? "ring-2 ring-blue-500"
                    : undefined
                }
              >
                <CardBody className="space-y-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{job.personName}</h3>
                        <Badge tone={statusTone(job.status)}>
                          {job.status === "claimed" ? "running" : job.status}
                        </Badge>
                        <span className="text-xs text-zinc-500">
                          Attempt {job.attemptCount}
                        </span>
                      </div>
                      <p className="mt-1 text-sm">
                        {job.request.organizationName}
                        {job.request.locationContext
                          ? ` · ${job.request.locationContext}`
                          : ""}
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Queued {job.createdAt.toLocaleString()}
                        {job.completedAt
                          ? ` · resolved ${job.completedAt.toLocaleString()}`
                          : ""}
                      </p>
                      {job.request.website && (
                        <a
                          href={job.request.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-700 underline dark:text-blue-300"
                        >
                          {job.request.website}
                        </a>
                      )}
                      {job.request.notes && (
                        <p className="mt-2 text-xs text-zinc-500">
                          Request notes: {job.request.notes}
                        </p>
                      )}
                      {job.request.dispatch && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <Badge
                            tone={
                              job.request.dispatch.status === "failed"
                                ? "danger"
                                : job.request.dispatch.status === "dispatching"
                                  ? "info"
                                  : "muted"
                            }
                          >
                            Worker trigger: {job.request.dispatch.status}
                          </Badge>
                          <span>
                            {job.request.dispatch.attemptCount} trigger attempt
                            {job.request.dispatch.attemptCount === 1 ? "" : "s"}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {job.request.dispatch &&
                        job.status === "pending" &&
                        (job.request.dispatch.status === "pending" ||
                          job.request.dispatch.status === "failed" ||
                          (job.request.dispatch.status === "dispatching" &&
                            job.request.dispatch.leaseExpiresAt &&
                            job.request.dispatch.leaseExpiresAt <= now) ||
                          (job.request.dispatch.status === "dispatched" &&
                            job.request.dispatch.lastAttemptAt &&
                            job.request.dispatch.lastAttemptAt.getTime() <=
                              now.getTime() - 2 * 60 * 1_000)) && (
                          <form action={retryDispatchAction}>
                            <input
                              type="hidden"
                              name="requestId"
                              value={job.request.id}
                            />
                            <input
                              type="hidden"
                              name="dispatchUpdatedAt"
                              value={job.request.dispatch.updatedAt.toISOString()}
                            />
                            <Button type="submit" variant="secondary" size="sm">
                              Retry worker trigger
                            </Button>
                          </form>
                        )}
                      {canRequeue && (
                        <form action={requeueJobAction}>
                          <input type="hidden" name="jobId" value={job.id} />
                          <Button type="submit" variant="secondary" size="sm">
                            Requeue and start research
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>

                  {job.status === "claimed" && job.claimExpiresAt && (
                    <p className="text-xs text-zinc-500">
                      Current claim lease expires{" "}
                      {job.claimExpiresAt.toLocaleString()}.
                    </p>
                  )}
                  {job.agentNotes && (
                    <p className="rounded-md bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                      Agent summary: {job.agentNotes}
                    </p>
                  )}

                  {job.candidates.map((candidate) => (
                    <article
                      key={candidate.id}
                      className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <strong>{candidate.email}</strong>
                            <Badge
                              tone={
                                candidate.confidence === "high"
                                  ? "success"
                                  : candidate.confidence === "medium"
                                    ? "warning"
                                    : "muted"
                              }
                            >
                              {candidate.confidence} confidence
                            </Badge>
                            <Badge
                              tone={
                                candidate.decision?.action === "approved"
                                  ? "success"
                                  : candidate.decision?.action === "rejected"
                                    ? "danger"
                                    : "warning"
                              }
                            >
                              {candidate.decision?.action ?? "awaiting review"}
                            </Badge>
                            {candidate.decision && (
                              <span className="text-xs text-zinc-500">
                                {candidate.decision.decidedAt.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-sm">
                            {candidate.personName} · {candidate.roleTitle} ·{" "}
                            {candidate.organization}
                          </p>
                          <p className="mt-1 text-xs capitalize text-zinc-500">
                            Method: {candidate.discoveryMethod.replaceAll("_", " ")}
                          </p>
                        </div>
                        <CopyProfessionalEmailButton email={candidate.email} />
                      </div>
                      <p className="text-sm">{candidate.evidence}</p>
                      {candidate.patternEvidence && (
                        <div className="text-sm text-zinc-600 dark:text-zinc-400">
                          <p>
                            Published pattern evidence: {candidate.patternEvidence}
                          </p>
                          {displayedPatternExamples(
                            candidate.patternExamples,
                          ).length > 0 && (
                            <ul className="mt-1 list-inside list-disc">
                              {displayedPatternExamples(
                                candidate.patternExamples,
                              ).map((example) => (
                                <li key={example.email}>
                                  {example.personName}: {example.email}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <ul className="space-y-1 text-sm">
                        {candidate.sourceUrls.map((sourceUrl) => (
                          <li key={sourceUrl}>
                            <a
                              href={sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="break-all text-blue-700 underline dark:text-blue-300"
                            >
                              {sourceUrl}
                            </a>
                          </li>
                        ))}
                      </ul>
                      {!candidate.decision && (
                        <div className="flex flex-wrap gap-2">
                          <form action={decideCandidateAction}>
                            <input
                              type="hidden"
                              name="candidateId"
                              value={candidate.id}
                            />
                            <input type="hidden" name="action" value="approved" />
                            <Button type="submit" size="sm">
                              Approve
                            </Button>
                          </form>
                          <form action={decideCandidateAction}>
                            <input
                              type="hidden"
                              name="candidateId"
                              value={candidate.id}
                            />
                            <input type="hidden" name="action" value="rejected" />
                            <Button type="submit" variant="danger" size="sm">
                              Reject
                            </Button>
                          </form>
                        </div>
                      )}
                    </article>
                  ))}
                </CardBody>
              </Card>
            );
          })
        )}
      </section>
    </main>
  );
}
