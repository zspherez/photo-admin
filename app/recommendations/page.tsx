import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
} from "@/lib/auth";
import { dashboardSessionIdentity } from "@/lib/dashboardSession";
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
  const query = parseRecommendationQuery(await searchParams);
  const now = new Date();
  const configuration = getAuthConfiguration();
  const cookieValue = (await cookies()).get(SESSION_COOKIE)?.value;
  const ownerKey = dashboardSessionIdentity(cookieValue, configuration).ownerKey;
  const result = await getTrajectoryRecommendationPage(query, { now });
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
        <h1 className="text-2xl font-semibold tracking-tight">
          Trajectory recommendations
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Read-only model evidence joined to current photo-admin show, contact,
          and outreach state.
        </p>
      </div>

      <RunHeader availability={result.availability} run={result.run} />

      {result.availability === "ready" && result.run && (
        <RecommendationsClient
          key={`${result.run.id}:${buildRecommendationHref(query)}`}
          initialRecommendations={result.recommendations}
          initialNextCursor={nextCursor}
          total={result.total}
          query={query}
        />
      )}
    </main>
  );
}
