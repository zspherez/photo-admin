import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { requireServerActionAuth } from "@/lib/auth";
import {
  getHistoricalOutcomeRecommendationPage,
  HISTORICAL_OUTCOME_PAGE_SIZE,
} from "@/lib/trajectoryHistoricalOutcomes";
import { firstSearchParam } from "@/lib/searchParams";
import { RecommendationFeedbackPanel } from "../recommendations-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Post-show trajectory outcomes" };

function pageNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function runTone(status: string): BadgeTone {
  if (status === "ready") return "success";
  if (status === "stale") return "warning";
  return "muted";
}

export default async function HistoricalOutcomesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireServerActionAuth("/recommendations/outcomes");
  const params = await searchParams;
  const page = pageNumber(firstSearchParam(params.page));
  const error = firstSearchParam(params.error);
  const outcomeSaved = firstSearchParam(params.outcome_saved);
  const offset = (page - 1) * HISTORICAL_OUTCOME_PAGE_SIZE;
  const result = await getHistoricalOutcomeRecommendationPage({ offset });
  const returnTo =
    page > 1 ? `/recommendations/outcomes?page=${page}` : "/recommendations/outcomes";
  const pageCount = Math.max(
    1,
    Math.ceil(result.total / HISTORICAL_OUTCOME_PAGE_SIZE),
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6">
        <Link
          href="/recommendations"
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to current recommendations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Post-show trajectory outcomes
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Historical recommendations from ready, stale, and superseded runs.
          Each outcome remains attached to its exact run, recommendation,
          artist, arm, and canonical show.
        </p>
      </div>

      {(error || outcomeSaved) && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
            error
              ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          {error ? `Action failed: ${error}` : "Show outcome saved."}
        </div>
      )}

      {result.recommendations.length === 0 ? (
        <Card>
          <CardBody>
            <p className="font-medium">No post-show outcomes are available.</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Recommendations appear here on their canonical show date. Existing
              outcomes remain available for correction if that date later changes.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-4">
          {result.recommendations.map((recommendation) => (
            <Card key={recommendation.id}>
              <CardBody className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{recommendation.artistName}</h2>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {formatDate(recommendation.showDate)} ·{" "}
                      {recommendation.venueName}
                      {recommendation.location
                        ? ` · ${recommendation.location}`
                        : ""}
                    </p>
                    {recommendation.eventName && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {recommendation.eventName}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="accent">{recommendation.arm}</Badge>
                    <Badge tone={runTone(recommendation.runStatus)}>
                      {recommendation.runStatus}
                    </Badge>
                  </div>
                </div>

                <dl className="grid gap-2 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Producer run</dt>
                    <dd className="break-all">{recommendation.producerRunId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Recommendation</dt>
                    <dd className="break-all">{recommendation.id}</dd>
                  </div>
                </dl>

                <RecommendationFeedbackPanel
                  recommendation={recommendation}
                  returnTo={returnTo}
                  outcomeOnly
                />
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <nav
          aria-label="Post-show outcome pages"
          className="mt-6 flex items-center justify-between"
        >
          <div>
            {page > 1 && (
              <LinkButton
                href={
                  page === 2
                    ? "/recommendations/outcomes"
                    : `/recommendations/outcomes?page=${page - 1}`
                }
                variant="secondary"
              >
                Previous
              </LinkButton>
            )}
          </div>
          <span className="text-sm text-zinc-500">
            Page {page} of {pageCount}
          </span>
          <div>
            {result.nextOffset !== null && (
              <LinkButton
                href={`/recommendations/outcomes?page=${page + 1}`}
                variant="secondary"
              >
                Next
              </LinkButton>
            )}
          </div>
        </nav>
      )}
    </main>
  );
}
