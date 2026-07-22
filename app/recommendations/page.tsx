import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
} from "@/lib/auth";
import { dashboardSessionIdentity } from "@/lib/dashboardSession";
import { dashboardReturnPath } from "@/lib/dashboardReturnUrl";
import {
  encodeRecommendationCursor,
} from "@/lib/trajectoryRecommendationCursor";
import {
  buildRecommendationHref,
  parseRecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";
import {
  getTrajectoryRecommendationPage,
  PROVISIONAL_TRAJECTORY_DISCLAIMER,
  type RecommendationAvailability,
  type RecommendationRun,
} from "@/lib/trajectoryRecommendations";
import { RecommendationsClient } from "./recommendations-client";
import { isWeekendET } from "@/lib/schedule";
import { firstSearchParam } from "@/lib/searchParams";
import { getTestOverride } from "@/lib/resend";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Trajectory recommendations" };

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function availabilityMessage(availability: RecommendationAvailability): {
  title: string;
  detail: string;
} {
  const messages: Record<
    RecommendationAvailability,
    { title: string; detail: string }
  > = {
    ready: {
      title: "Current recommendation run",
      detail: "This run is fresh, active, and within its declared validity window.",
    },
    none: {
      title: "No trajectory run is available",
      detail: "Import and promote a validated run before recommendations can be reviewed.",
    },
    failed: {
      title: "The latest trajectory run failed",
      detail: "Failed model data is retained for diagnosis and is not actionable.",
    },
    stale: {
      title: "The trajectory run is stale",
      detail: "Stale recommendations are not shown. Refresh and promote a current run.",
    },
    expired: {
      title: "The trajectory run expired",
      detail: "Expired recommendations are not shown, even if the run still has ready status.",
    },
    superseded: {
      title: "No active trajectory run",
      detail: "Superseded data is never used as a silent fallback.",
    },
    multiple_ready: {
      title: "Trajectory run state needs repair",
      detail: "More than one ready run was found, so no recommendations are actionable.",
    },
  };
  return messages[availability];
}

function RunHeader({
  availability,
  run,
}: {
  availability: RecommendationAvailability;
  run: RecommendationRun | null;
}) {
  const message = availabilityMessage(availability);
  const actionable = availability === "ready";
  return (
    <Card
      className={
        actionable
          ? "border-emerald-200 dark:border-emerald-900"
          : "border-amber-200 dark:border-amber-900"
      }
    >
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{message.title}</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {message.detail}
            </p>
          </div>
          <Badge tone={actionable ? "success" : "warning"}>
            {actionable ? "Fresh" : availability.replaceAll("_", " ")}
          </Badge>
        </div>

        {run && (
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Generated
              </dt>
              <dd className="mt-1">{formatTimestamp(run.generatedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                As of
              </dt>
              <dd className="mt-1">{formatDate(run.asOfDate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Decision date
              </dt>
              <dd className="mt-1">{formatDate(run.decisionDate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Minimum show date
              </dt>
              <dd className="mt-1">{formatDate(run.minimumShowDate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Valid until
              </dt>
              <dd className="mt-1">{formatTimestamp(run.validUntil)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Run status
              </dt>
              <dd className="mt-1">{run.status}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Freshness
              </dt>
              <dd className="mt-1">{run.freshness}</dd>
            </div>
          </dl>
        )}

        {run && (
          <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">
            <span className="font-medium">Model status:</span>{" "}
            <code className="break-all">{run.modelStatus}</code>
          </div>
        )}
        {run?.failureMessage && (
          <p className="text-sm text-red-700 dark:text-red-300">
            {run.failureCode ? `${run.failureCode}: ` : ""}
            {run.failureMessage}
          </p>
        )}
        <p className="font-medium text-amber-800 dark:text-amber-200">
          {PROVISIONAL_TRAJECTORY_DISCLAIMER}
        </p>
      </CardBody>
    </Card>
  );
}

export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = parseRecommendationQuery(params);
  const rawReturnTo = firstSearchParam(params.returnTo);
  const dashboardReturnTo = rawReturnTo
    ? dashboardReturnPath(rawReturnTo)
    : null;
  const now = new Date();
  const resultMessage =
    firstSearchParam(params.error) ??
    (firstSearchParam(params.sent)
      ? "Email sent."
      : firstSearchParam(params.scheduled)
        ? "Email scheduled."
        : firstSearchParam(params.cancelled)
          ? "Scheduled outreach cancelled."
          : firstSearchParam(params.followup_sent)
            ? "Follow-up sent."
            : firstSearchParam(params.followup_scheduled)
              ? "Follow-up scheduled."
              : firstSearchParam(params.marked)
                ? "Marked as sent."
                : firstSearchParam(params.unmarked)
                  ? "Manual mark removed."
                  : firstSearchParam(params.decision_saved)
                    ? "Trajectory decision saved."
                    : firstSearchParam(params.outcome_saved)
                      ? "Show outcome saved."
                      : firstSearchParam(params.outreach_attributed)
                        ? "Outreach attribution saved."
                  : null);
  const resultIsError = Boolean(firstSearchParam(params.error));
  const configuration = getAuthConfiguration();
  const cookieValue = (await cookies()).get(SESSION_COOKIE)?.value;
  const ownerKey = dashboardSessionIdentity(cookieValue, configuration).ownerKey;
  const [result, testOverride] = await Promise.all([
    getTrajectoryRecommendationPage(query, { now }),
    getTestOverride(),
  ]);
  const nextCursor =
    result.run && result.nextOffset !== null
      ? encodeRecommendationCursor(
          result.run.id,
          result.nextOffset,
          query,
          ownerKey,
        )
      : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6">
        {dashboardReturnTo && (
          <Link
            href={dashboardReturnTo}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ← Back to matched shows
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">
          Trajectory recommendations
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Model evidence joined to current photo-admin workflow state. Outreach
          changes happen only when you choose an action below.
        </p>
        <div className="mt-3">
          <LinkButton
            href="/recommendations/outcomes"
            variant="secondary"
            size="sm"
          >
            Post-show outcomes
          </LinkButton>
        </div>
      </div>

      {resultMessage && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
            resultIsError
              ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          {resultIsError ? `Action failed: ${resultMessage}` : resultMessage}
        </div>
      )}
      {testOverride && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Test override active — all email actions send to{" "}
          <b>{testOverride}</b>.
        </div>
      )}

      <RunHeader availability={result.availability} run={result.run} />

      {result.availability === "ready" && result.run && (
        <RecommendationsClient
          key={`${result.run.id}:${buildRecommendationHref(query)}`}
          initialRecommendations={result.recommendations}
          initialNextCursor={nextCursor}
          total={result.total}
          query={query}
          isWeekend={isWeekendET(now)}
          dashboardReturnTo={dashboardReturnTo}
        />
      )}
    </main>
  );
}
