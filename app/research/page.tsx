import type { Metadata } from "next";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  approveContactResearchCandidate,
  approveContactResearchDirectOutreach,
  countRetryableExhaustedContactResearchJobs,
  refreshContactResearchQueue,
  rejectContactResearchCandidate,
  rejectContactResearchDirectOutreach,
  retryAllExhaustedContactResearchJobs,
  retryAllReviewContactResearchJobs,
  retryContactResearchJob,
  skipContactResearchArtist,
  unskipContactResearchArtist,
  updateContactResearchJobUserNotes,
} from "@/lib/contactResearch";
import { requireServerActionAuth } from "@/lib/auth";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { parseContactResearchView } from "@/lib/contactResearchView";
import { formatShowDate } from "@/lib/formatDate";
import { Card, CardBody } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { ContactResearchControls } from "@/components/contact-research-controls";
import { DirectOutreachProvenance } from "@/components/direct-outreach-provenance";
import { AutoDismissStatus } from "./auto-dismiss-status";
import { easternTodayStoredDate } from "@/lib/calendarDate";
import {
  RESEARCH_JOB_STATUSES,
  RESEARCH_STATUS_FILTERS,
  parseResearchStatusFilter,
  researchStatusCounts,
  researchStatusFilterDefinition,
  researchStatusHref,
} from "@/lib/researchStatusFilter";
import {
  type VenueTier,
  venueTierSql,
  venueTierLabel,
} from "@/lib/venueTier";
import { festivalLeadTimeSql } from "@/lib/festivalEligibility";
import { directOutreachInstructionExcerptFromCanonical } from "@/lib/directOutreachInstruction";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact research" };
const WORKFLOW_URL =
  "https://github.com/zspherez/photo-admin/actions/workflows/contact-research.yml";

function actionResearchFilter(formData: FormData) {
  return parseResearchStatusFilter(formData.get("status"));
}

async function refreshQueueAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  let destination: string;
  try {
    const result = await refreshContactResearchQueue();
    destination = researchStatusHref(filter, {
      refreshed: "1",
      eligible: String(result.eligible),
      enqueued: String(result.enqueued),
    });
  } catch (error) {
    destination = researchStatusHref(filter, {
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
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) {
    redirect(researchStatusHref(filter, { error: "missing_candidate" }));
  }
  const result = await approveContactResearchCandidate(candidateId);
  revalidatePath("/research");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/settings/contacts");
  if (!result.ok) {
    redirect(
      researchStatusHref(filter, {
        error: "approve_failed",
        detail: result.error ?? "Candidate could not be approved",
      })
    );
  }
}

async function rejectCandidateAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const candidateId = String(formData.get("candidateId") ?? "").trim();
  if (!candidateId) {
    redirect(researchStatusHref(filter, { error: "missing_candidate" }));
  }

  const result = await rejectContactResearchCandidate(candidateId);
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!result.ok) {
    redirect(
      researchStatusHref(filter, {
        error: "reject_failed",
        detail: result.error ?? "Candidate could not be rejected",
      })
    );
  }

}

async function approveDirectOutreachAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const proposalId = String(formData.get("proposalId") ?? "").trim();
  if (!proposalId) {
    redirect(researchStatusHref(filter, { error: "missing_proposal" }));
  }
  const result = await approveContactResearchDirectOutreach(proposalId);
  revalidatePath("/research");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  if (!result.ok) {
    redirect(
      researchStatusHref(filter, {
        error: "approve_failed",
        detail: result.error ?? "Direct outreach could not be approved",
      })
    );
  }
}

async function rejectDirectOutreachAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const proposalId = String(formData.get("proposalId") ?? "").trim();
  if (!proposalId) {
    redirect(researchStatusHref(filter, { error: "missing_proposal" }));
  }
  const result = await rejectContactResearchDirectOutreach(proposalId);
  revalidatePath("/research");
  if (!result.ok) {
    redirect(
      researchStatusHref(filter, {
        error: "reject_failed",
        detail: result.error ?? "Direct outreach could not be rejected",
      })
    );
  }
}

async function retryJobAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(researchStatusHref(filter, { error: "missing_job" }));
  }
  const retried = await retryContactResearchJob(jobId);
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!retried) {
    redirect(researchStatusHref(filter, { error: "retry_failed" }));
  }
}

async function saveResearchNotesAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(researchStatusHref(filter, { error: "missing_job" }));
  }
  let updated = false;
  try {
    updated = await updateContactResearchJobUserNotes(
      jobId,
      formData.get("userNotes")
    );
  } catch (error) {
    redirect(
      researchStatusHref(filter, {
        error: "notes_failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          180
        ),
      })
    );
  }
  revalidatePath("/research");
  if (!updated) {
    redirect(researchStatusHref(filter, { error: "notes_failed" }));
  }
}

async function retryAllExhaustedJobsAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  let destination: string;
  try {
    const result = await retryAllExhaustedContactResearchJobs();
    const skipped = Object.values(result.skipped).reduce(
      (total, count) => total + count,
      0
    );
    destination = researchStatusHref(filter, {
      requeue_exhausted: "1",
      requeued: String(result.requeued),
      skipped: String(skipped),
      skipped_status_changed: String(result.skipped.status_changed),
      skipped_effective_approval: String(
        result.skipped.effective_approval
      ),
      skipped_active_contact: String(result.skipped.active_contact),
      skipped_intentional_skip: String(result.skipped.intentional_skip),
      skipped_pending_direct_outreach: String(
        result.skipped.pending_direct_outreach
      ),
      skipped_no_eligible_show: String(result.skipped.no_eligible_show),
    });
  } catch (error) {
    destination = researchStatusHref(filter, {
      error: "requeue_exhausted",
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

async function retryAllReviewJobsAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  await retryAllReviewContactResearchJobs();
  revalidatePath("/research");
  revalidatePath("/settings");
}

async function skipArtistAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(researchStatusHref(filter, { error: "missing_job" }));
  }
  let skipped = false;
  try {
    skipped = await skipContactResearchArtist(
      jobId,
      formData.get("reason")
    );
  } catch (error) {
    redirect(
      researchStatusHref(filter, {
        error: "skip_failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(
          0,
          180
        ),
      })
    );
  }
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!skipped) {
    redirect(researchStatusHref(filter, { error: "skip_failed" }));
  }
}

async function unskipArtistAction(formData: FormData) {
  "use server";
  await requireServerActionAuth(
    researchStatusHref(actionResearchFilter(formData))
  );
  const filter = actionResearchFilter(formData);
  const jobId = String(formData.get("jobId") ?? "").trim();
  if (!jobId) {
    redirect(researchStatusHref(filter, { error: "missing_job" }));
  }
  const unskipped = await unskipContactResearchArtist(jobId);
  revalidatePath("/research");
  revalidatePath("/settings");
  if (!unskipped) {
    redirect(researchStatusHref(filter, { error: "unskip_failed" }));
  }
}

function statusTone(status: string): BadgeTone {
  if (status === "review") return "warning";
  if (status === "claimed") return "info";
  if (status === "pending") return "accent";
  if (status === "skipped") return "warning";
  if (status === "exhausted") return "muted";
  return "default";
}

function confidenceTone(confidence: string): BadgeTone {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "warning";
  return "muted";
}

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
    requeue_exhausted?: SearchParamValue;
    requeued?: SearchParamValue;
    skipped?: SearchParamValue;
    skipped_status_changed?: SearchParamValue;
    skipped_effective_approval?: SearchParamValue;
    skipped_active_contact?: SearchParamValue;
    skipped_intentional_skip?: SearchParamValue;
    skipped_pending_direct_outreach?: SearchParamValue;
    skipped_no_eligible_show?: SearchParamValue;
    status?: SearchParamValue;
    view?: SearchParamValue;
  }>;
}) {
  const raw = await searchParams;
  const activeFilter =
    raw.status === undefined &&
    parseContactResearchView(raw.view) === "skipped"
      ? "skipped"
      : parseResearchStatusFilter(raw.status);
  const activeFilterDefinition =
    researchStatusFilterDefinition(activeFilter);
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
    requeueExhausted: firstSearchParam(raw.requeue_exhausted),
    requeued: firstSearchParam(raw.requeued),
    skipped: firstSearchParam(raw.skipped),
    skippedStatusChanged: firstSearchParam(raw.skipped_status_changed),
    skippedEffectiveApproval: firstSearchParam(
      raw.skipped_effective_approval
    ),
    skippedActiveContact: firstSearchParam(raw.skipped_active_contact),
    skippedIntentionalSkip: firstSearchParam(
      raw.skipped_intentional_skip
    ),
    skippedPendingDirectOutreach: firstSearchParam(
      raw.skipped_pending_direct_outreach
    ),
    skippedNoEligibleShow: firstSearchParam(
      raw.skipped_no_eligible_show
    ),
  };
  const requeueSkipDetails = [
    [status.skippedStatusChanged, "status changed"],
    [status.skippedEffectiveApproval, "effective approval"],
    [status.skippedActiveContact, "active email contact"],
    [status.skippedIntentionalSkip, "intentional skip"],
    [status.skippedPendingDirectOutreach, "pending direct outreach"],
    [status.skippedNoEligibleShow, "no eligible show"],
  ]
    .filter(([count]) => count && count !== "0")
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
  const now = new Date();
  const today = easternTodayStoredDate(now);
  const bestTierExpression = venueTierSql(
    Prisma.sql`show."venueName"`,
    Prisma.sql`show."eventName"`
  );
  const visibleStatusWhere =
    activeFilter === "skipped"
      ? Prisma.sql`
          job."status" = 'skipped'
          AND EXISTS (
            SELECT 1
            FROM "ArtistResearchSkip" research_skip
            WHERE research_skip."artistId" = job."artistId"
              AND research_skip."clearedAt" IS NULL
          )
        `
      : Prisma.sql`
          job."status" IN (${Prisma.join([
            ...activeFilterDefinition.statuses,
          ])})
          AND (
            job."status" <> 'claimed'
            OR job."claimExpiresAt" > ${now}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "ArtistResearchSkip" research_skip
            WHERE research_skip."artistId" = job."artistId"
              AND research_skip."clearedAt" IS NULL
          )
        `;
  const [
    groupedCounts,
    skippedCount,
    retryReviewCount,
    retryExhaustedCount,
    rankedSummaries,
  ] = await Promise.all([
    db.contactResearchJob.groupBy({
      by: ["status"],
      where: {
        status: { in: [...RESEARCH_JOB_STATUSES] },
        OR: [
          { status: { not: "claimed" } },
          { claimExpiresAt: { gt: now } },
        ],
      },
      _count: { _all: true },
    }),
    db.artistResearchSkip.count({
      where: { clearedAt: null },
    }),
    db.contactResearchJob.count({
      where: {
        status: "review",
        candidates: {
          none: { status: { in: ["approved", "superseded"] } },
        },
        directOutreachProposals: {
          none: { status: "pending" },
        },
      },
    }),
    countRetryableExhaustedContactResearchJobs(now),
    db.$queryRaw<
      Array<{
        id: string;
        bestShowDate: Date | null;
        bestVenueName: string | null;
        bestEventName: string | null;
        bestTier: number;
      }>
    >(Prisma.sql`
      SELECT
        job."id",
        best_show."date" AS "bestShowDate",
        best_show."venueName" AS "bestVenueName",
        best_show."eventName" AS "bestEventName",
        COALESCE(best_show."tier", 0) AS "bestTier"
      FROM "ContactResearchJob" job
      LEFT JOIN LATERAL (
        SELECT
          show."date",
          show."venueName",
          show."eventName",
          ${bestTierExpression} AS "tier"
        FROM "ShowArtist" show_artist
        JOIN "Show" show
          ON show."id" = show_artist."showId"
        WHERE show_artist."artistId" = job."artistId"
          AND show."date" >= ${today}
          AND show."syncStatus" = 'active'
          AND ${festivalLeadTimeSql(now)}
        ORDER BY "tier" DESC, show."date" ASC
        LIMIT 1
      ) best_show ON TRUE
      WHERE ${visibleStatusWhere}
      ORDER BY
        ${
          activeFilter === "all"
            ? Prisma.sql`CASE WHEN job."status" = 'exhausted' THEN 1 ELSE 0 END,`
            : Prisma.sql``
        }
        COALESCE(best_show."tier", 0) DESC,
        CASE job."status"
          WHEN 'review' THEN 0
          WHEN 'claimed' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'complete' THEN 3
          WHEN 'exhausted' THEN 4
          ELSE 99
        END,
        job."priority" DESC,
        job."nextShowAt" ASC NULLS LAST,
        job."createdAt" ASC
      LIMIT 125
    `),
  ]);
  const counts = researchStatusCounts(
    groupedCounts.map((row) => ({
      status: row.status,
      count: row._count._all,
    }))
  );
  counts.set("skipped", skippedCount);
  const detailedRows = await db.contactResearchJob.findMany({
    where: { id: { in: rankedSummaries.map((job) => job.id) } },
    include: {
      artist: {
        select: {
          id: true,
          name: true,
          popularity: true,
          contacts: {
            where: {
              state: "active",
              directOutreachIdentity: { not: null },
            },
            orderBy: { updatedAt: "desc" },
          },
          researchSkips: {
            where: { clearedAt: null },
            orderBy: { setAt: "desc" },
            take: 1,
          },
        },
      },
      candidates: {
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      },
      directOutreachProposals: {
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  const detailsById = new Map(detailedRows.map((job) => [job.id, job]));
  const jobs = rankedSummaries.flatMap((summary) => {
    const details = detailsById.get(summary.id);
    return details
      ? [
          {
            ...details,
            bestShow:
              summary.bestShowDate && summary.bestVenueName
                ? {
                    date: summary.bestShowDate,
                    venueName: summary.bestVenueName,
                    eventName: summary.bestEventName,
                    tier: summary.bestTier as VenueTier,
                  }
                : null,
          },
        ]
      : [];
  });
  const activeCount =
    (counts.get("pending") ?? 0) +
    (counts.get("claimed") ?? 0) +
    (counts.get("review") ?? 0);
  const exhaustedCount = counts.get("exhausted") ?? 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Contact research
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Email candidates require normal review unless directly published.
            Trusted-rule direct outreach may be added automatically, but
            nothing is ever sent.
          </p>
        </div>
        <div className="mobile-action-grid flex flex-wrap gap-2 sm:w-auto">
          <LinkButton
            href={WORKFLOW_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open research workflow ↗
          </LinkButton>
          <form action={retryAllReviewJobsAction}>
            <input type="hidden" name="status" value={activeFilter} />
            <PendingSubmitButton
              variant="secondary"
              pendingLabel="Requeueing…"
              disabled={retryReviewCount === 0}
            >
              Requeue all review ({retryReviewCount})
            </PendingSubmitButton>
          </form>
          <form action={retryAllExhaustedJobsAction}>
            <input type="hidden" name="status" value={activeFilter} />
            <PendingSubmitButton
              variant="secondary"
              pendingLabel="Requeueing…"
              disabled={retryExhaustedCount === 0}
            >
              Requeue eligible exhausted ({retryExhaustedCount})
            </PendingSubmitButton>
          </form>
          <form action={refreshQueueAction}>
            <input type="hidden" name="status" value={activeFilter} />
            <PendingSubmitButton
              variant="secondary"
              pendingLabel="Refreshing…"
            >
              Refresh queue
            </PendingSubmitButton>
          </form>
        </div>
      </div>
      {exhaustedCount > retryExhaustedCount && (
        <p className="mt-2 text-xs text-zinc-500">
          {exhaustedCount.toLocaleString()} exhausted job(s) total;{" "}
          {retryExhaustedCount.toLocaleString()} currently pass all contact,
          skip, proposal, and upcoming-show retry checks. Refresh queue archives
          exhausted jobs without an eligible upcoming show as inactive until a
          future show makes them eligible again.
        </p>
      )}

      <nav
        aria-label="Filter contact research jobs by status"
        className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {RESEARCH_STATUS_FILTERS.map((filter) => {
          const isActive = filter.key === activeFilter;
          const count = counts.get(filter.key) ?? 0;
          return (
            <Link
              key={filter.key}
              href={researchStatusHref(filter.key)}
              aria-current={isActive ? "page" : undefined}
              aria-label={`Show ${filter.countLabel} contact research jobs: ${count}`}
              className={`rounded-xl border bg-white p-4 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 dark:bg-zinc-950 dark:focus-visible:ring-zinc-600 dark:focus-visible:ring-offset-zinc-950 ${
                isActive
                  ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
                  : "border-zinc-200 hover:border-zinc-400 hover:shadow-md dark:border-zinc-800 dark:hover:border-zinc-600"
              }`}
            >
              <p
                className={`text-xs ${
                  isActive
                    ? "font-medium text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500"
                }`}
              >
                {filter.label}
              </p>
              <p className="mt-1 text-xl font-semibold">{count}</p>
            </Link>
          );
        })}
      </nav>

      {status.refreshed && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Queue refreshed: {status.eligible ?? "0"} eligible ·{" "}
            {status.enqueued ?? "0"} newly queued.
          </div>
        </AutoDismissStatus>
      )}
      {status.requeueExhausted && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Exhausted research requeue: {status.requeued ?? "0"} requeued ·{" "}
            {status.skipped ?? "0"} skipped
            {requeueSkipDetails ? ` (${requeueSkipDetails})` : ""}.
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
      {status.error && (
        <AutoDismissStatus>
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {status.detail ?? status.error}
          </div>
        </AutoDismissStatus>
      )}

      {process.env.NODE_ENV !== "production" &&
        !process.env.CONTACT_RESEARCH_AGENT_TOKEN && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Set <code>CONTACT_RESEARCH_AGENT_TOKEN</code> only for an explicit
          local worker. Hosted workers use GitHub Actions OIDC.
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>
          {activeFilter === "all"
            ? `${activeCount} active jobs`
            : `${counts.get(activeFilter) ?? 0} ${activeFilterDefinition.countLabel} jobs`}
        </span>
        <span>
          Run locally with <code>npm run contact-research:agent</code>
        </span>
      </div>

      {jobs.length === 0 ? (
        <Card className="mt-3">
          <CardBody className="py-12 text-center text-sm text-zinc-500">
            {activeFilter === "all"
              ? "No contact research jobs. Refresh after show and listen syncs."
              : activeFilter === "skipped"
                ? "No artists are intentionally skipped."
                : `No ${activeFilterDefinition.countLabel} contact research jobs.`}
          </CardBody>
        </Card>
      ) : (
        <div className="mt-3 space-y-3">
          {jobs.map((job) => {
            const pendingCandidates = job.candidates.filter(
              (candidate) => candidate.status === "pending"
            );
            const approvedCandidateCount = job.candidates.filter(
              (candidate) => candidate.status === "approved"
            ).length;
            const hasApprovalHistory = job.candidates.some((candidate) =>
              ["approved", "superseded"].includes(candidate.status)
            );
            const pendingDirectOutreach =
              job.directOutreachProposals.filter(
                (proposal) => proposal.status === "pending",
              );
            const hasReviewedDirectOutreach =
              job.directOutreachProposals.some(
                (proposal) => proposal.status !== "pending",
              );
            const activeSkip = job.artist.researchSkips[0] ?? null;
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
                        {job.bestShow
                          ? ` · ${venueTierLabel(job.bestShow.tier)} · ${job.bestShow.eventName || job.bestShow.venueName}`
                          : " · Venue tier unknown"}
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

                  {job.artist.contacts.map((contact) => (
                    <DirectOutreachProvenance
                      key={contact.id}
                      contact={contact}
                      className="mt-3"
                    />
                  ))}

                  <div className="mt-3">
                    <ContactResearchControls
                      idPrefix={`research-${job.id}`}
                      userNotes={job.userNotes}
                      activeSkip={activeSkip}
                      saveAction={saveResearchNotesAction}
                      skipAction={skipArtistAction}
                      unskipAction={unskipArtistAction}
                      hiddenFields={[
                        { name: "jobId", value: job.id },
                        { name: "status", value: activeFilter },
                      ]}
                    />
                  </div>

                  {(approvedCandidateCount > 0 ||
                    pendingCandidates.length > 0) && (
                    <p className="mt-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      {approvedCandidateCount} approved ·{" "}
                      {pendingCandidates.length} awaiting review
                    </p>
                  )}

                  {pendingDirectOutreach.map((proposal) => (
                    <div
                      key={proposal.id}
                      className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          Direct outreach proposal
                        </span>
                        <Badge tone="warning">human review required</Badge>
                      </div>
                      <p className="mt-2">{proposal.note}</p>
                      <p className="mt-1 text-xs">
                        Manager: {proposal.managerName}
                        {proposal.managerCompany
                          ? ` · ${proposal.managerCompany}`
                          : ""}
                      </p>
                      <p className="mt-1 text-xs">
                        Trusted instruction v{proposal.ruleVersion}:{" "}
                        {directOutreachInstructionExcerptFromCanonical(
                          proposal.canonicalRule,
                        )}
                      </p>
                      <div className="mt-2 space-y-2">
                        {proposal.evidenceQuotes.map((quote, index) => (
                          <div key={`${proposal.id}-${index}`}>
                            <p className="text-xs">{quote}</p>
                            <a
                              href={proposal.sourceUrls[index]}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="break-all text-xs underline"
                            >
                              Evidence {index + 1} ↗
                            </a>
                          </div>
                        ))}
                      </div>
                      {!activeSkip && (
                        <div className="mobile-action-grid mt-3 flex gap-2 sm:w-auto">
                          <form action={approveDirectOutreachAction}>
                            <input
                              type="hidden"
                              name="proposalId"
                              value={proposal.id}
                            />
                            <input
                              type="hidden"
                              name="status"
                              value={activeFilter}
                            />
                            <PendingSubmitButton
                              size="sm"
                              pendingLabel="Approving…"
                            >
                              Approve direct outreach
                            </PendingSubmitButton>
                          </form>
                          <form action={rejectDirectOutreachAction}>
                            <input
                              type="hidden"
                              name="proposalId"
                              value={proposal.id}
                            />
                            <input
                              type="hidden"
                              name="status"
                              value={activeFilter}
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
                      )}
                    </div>
                  ))}

                  {pendingCandidates.length > 0 && (
                    <div className="mt-4 space-y-3">
                      {pendingCandidates.map((candidate) => (
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
                          {!activeSkip && (
                            <div className="mobile-action-grid mt-3 flex gap-2 sm:w-auto">
                              <form action={approveCandidateAction}>
                                <input
                                  type="hidden"
                                  name="candidateId"
                                  value={candidate.id}
                                />
                                <input
                                  type="hidden"
                                  name="status"
                                  value={activeFilter}
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
                                <input
                                  type="hidden"
                                  name="status"
                                  value={activeFilter}
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
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {(job.status === "exhausted" ||
                    (job.status === "review" &&
                     pendingDirectOutreach.length === 0 &&
                     pendingCandidates.length === 0 &&
                     (!hasApprovalHistory ||
                       (hasReviewedDirectOutreach &&
                          approvedCandidateCount === 0)))) && (
                    <form action={retryJobAction} className="mt-3">
                      <input type="hidden" name="jobId" value={job.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={activeFilter}
                      />
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
