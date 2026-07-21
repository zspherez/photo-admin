"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtistLink } from "@/components/artist-modal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatShowDate } from "@/lib/formatDate";
import { mergeUniqueByKey } from "@/lib/dashboardInfinite";
import {
  buildRecommendationBatchHref,
  buildRecommendationHref,
  recommendationQueryWith,
  type RecommendationDateBand,
  type RecommendationQuery,
  type RecommendationTab,
  type RecommendationWorkflow,
} from "@/lib/trajectoryRecommendationQuery";
import {
  groupRecommendationsByDate,
  type RecommendationView,
} from "@/lib/trajectoryRecommendationView";

const TABS: Array<{ value: RecommendationTab; label: string }> = [
  { value: "suggested", label: "Suggested slate" },
  { value: "trajectory", label: "Trajectory" },
  { value: "exploration", label: "Exploration" },
  { value: "portfolio", label: "Portfolio" },
  { value: "momentum", label: "Broader momentum" },
];

const WORKFLOWS: Array<{
  value: RecommendationWorkflow;
  label: string;
}> = [
  { value: "all", label: "All workflow states" },
  { value: "ready", label: "Ready to contact" },
  { value: "needs", label: "Needs contact" },
  { value: "direct", label: "Direct outreach" },
  { value: "interested", label: "Interested" },
  { value: "sent", label: "Sent / scheduled" },
  { value: "opened", label: "Opened" },
  { value: "clicked", label: "Clicked" },
  { value: "dismissed", label: "Dismissed" },
];

const DATE_BANDS: Array<{
  value: RecommendationDateBand;
  label: string;
  description: string;
}> = [
  { value: "all", label: "All 5–90 days", description: "Entire planning horizon" },
  { value: "5-10", label: "5–10 days", description: "Review/listen; short lead" },
  { value: "10-45", label: "10–45 days", description: "Normal outreach window" },
  { value: "45-90", label: "45–90 days", description: "Later planning" },
];

interface BatchPayload {
  recommendations: RecommendationView[];
  nextCursor: string | null;
}

function armTone(arm: RecommendationView["arm"]): BadgeTone {
  if (arm === "trajectory") return "accent";
  if (arm === "momentum") return "info";
  if (arm === "portfolio") return "success";
  return "warning";
}

function contactTone(
  category: RecommendationView["contactCategory"],
): BadgeTone {
  if (category === "ready_email") return "success";
  if (category === "direct_outreach") return "info";
  if (category === "needs_email") return "warning";
  return "danger";
}

function RecommendationCard({
  recommendation,
  role,
  returnTo,
}: {
  recommendation: RecommendationView;
  role: "primary" | "backup";
  returnTo: string;
}) {
  return (
    <Card data-recommendation-identity={recommendation.identityKey}>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={role === "primary" ? "accent" : "muted"}>
                {role === "primary" ? "Primary option" : "Backup option"}
              </Badge>
              <Badge tone={armTone(recommendation.arm)}>
                {recommendation.arm === "momentum"
                  ? "Broader momentum"
                  : recommendation.arm}
              </Badge>
              <Badge tone="muted">Arm rank #{recommendation.listRank}</Badge>
              {recommendation.slatePosition && (
                <Badge tone="default">
                  Slate #{recommendation.slatePosition}
                </Badge>
              )}
            </div>
            <h3 className="mt-2 text-lg font-semibold">
              <ArtistLink
                artistId={recommendation.artistId}
                returnTo={returnTo}
              >
                {recommendation.artistName}
              </ArtistLink>
            </h3>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {formatShowDate(recommendation.showDate, {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {recommendation.venueName}
              {recommendation.location ? ` · ${recommendation.location}` : ""}
            </p>
            {recommendation.eventName && (
              <p className="mt-1 text-xs text-zinc-500">
                {recommendation.eventName}
              </p>
            )}
          </div>
          {recommendation.ticketUrl && (
            <LinkButton
              href={recommendation.ticketUrl}
              target="_blank"
              rel="noreferrer"
              variant="secondary"
              size="sm"
            >
              Tickets
            </LinkButton>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge tone="muted">
            Billing {recommendation.billingPosition}/{recommendation.lineupSize}
          </Badge>
          {recommendation.isFirstBilled && (
            <Badge tone="accent">First billed</Badge>
          )}
          <Badge tone={contactTone(recommendation.contactCategory)}>
            {recommendation.contactLabel}
          </Badge>
          {recommendation.interested && <Badge tone="success">Interested</Badge>}
          {recommendation.dismissed && <Badge tone="muted">Dismissed</Badge>}
          {recommendation.outreachLabels.map((label) => (
            <Badge key={label} tone={label === "No outreach" ? "muted" : "info"}>
              {label}
            </Badge>
          ))}
          <Badge tone="muted">Access not recorded</Badge>
        </div>

        {recommendation.contactDetail && (
          <p className="break-words text-sm">
            <span className="font-medium">Contact:</span>{" "}
            {recommendation.contactDetail}
          </p>
        )}

        <div>
          <h4 className="text-sm font-semibold">Why it is here</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {recommendation.rationale.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>

        {recommendation.analogSummary && (
          <div className="rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">Nearest historical analogs</h4>
              <span
                className="cursor-help text-xs text-zinc-500 underline decoration-dotted"
                title="Descriptive historical comparison only, not a probability or forecast."
              >
                descriptive, not probability
              </span>
            </div>
            <p className="mt-1">
              {recommendation.analogSummary.names.length > 0
                ? recommendation.analogSummary.names.join(", ")
                : "No analog names available"}
            </p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {recommendation.analogSummary.positiveNeighbors} of{" "}
              {recommendation.analogSummary.neighborCount} nearest comparisons
              had sustained expansion. Historical pool base rate (descriptive):{" "}
              {recommendation.analogSummary.poolBaseRatePercent}%.
            </p>
          </div>
        )}

        <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer font-medium">Details</summary>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Coverage state</dt>
              <dd>{recommendation.details.coverageState}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Momentum band</dt>
              <dd>{recommendation.details.momentumBand ?? "Not available"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Completed bookings</dt>
              <dd>
                {recommendation.details.eventsPrior6m ?? "—"} →{" "}
                {recommendation.details.eventsRecent6m ?? "—"} (
                {recommendation.details.eventDelta6m ?? "—"})
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Markets</dt>
              <dd>
                {recommendation.details.marketsPrior6m ?? "—"} →{" "}
                {recommendation.details.marketsRecent6m ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Career age</dt>
              <dd>
                {recommendation.details.careerAgeYears === null
                  ? "Not available"
                  : `${recommendation.details.careerAgeYears} years`}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Genres</dt>
              <dd>
                {recommendation.details.genres.length > 0
                  ? recommendation.details.genres.join(", ")
                  : "Not available"}
              </dd>
            </div>
          </dl>
          <pre className="mt-3 max-h-52 overflow-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-100">
            {JSON.stringify(recommendation.details.releaseContext, null, 2)}
          </pre>
        </details>
      </CardBody>
    </Card>
  );
}

export function RecommendationsClient({
  initialRecommendations,
  initialNextCursor,
  total,
  query,
}: {
  initialRecommendations: RecommendationView[];
  initialNextCursor: string | null;
  total: number;
  query: RecommendationQuery;
}) {
  const [recommendations, setRecommendations] = useState(
    initialRecommendations,
  );
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const groups = useMemo(
    () => groupRecommendationsByDate(recommendations),
    [recommendations],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        buildRecommendationBatchHref(query, nextCursor),
        { headers: { Accept: "application/json" } },
      );
      if (response.status === 410) {
        setNextCursor(null);
        setError("The active recommendation run changed or expired. Refresh.");
        return;
      }
      if (!response.ok) throw new Error("Could not load recommendations");
      const payload = (await response.json()) as BatchPayload;
      const merged = mergeUniqueByKey(
        recommendations,
        payload.recommendations,
        (item) => item.identityKey,
      );
      setRecommendations(merged.items);
      setAnnouncement(
        `Loaded ${merged.added} more recommendation${merged.added === 1 ? "" : "s"}.`,
      );
      setNextCursor(payload.nextCursor);
    } catch {
      setError("Couldn’t load more recommendations.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextCursor, query, recommendations]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || !("IntersectionObserver" in window)) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (reducedMotion || connection?.saveData) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  return (
    <section className="mt-6" aria-labelledby="recommendation-results">
      <nav
        aria-label="Recommendation arms"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={buildRecommendationHref(
              recommendationQueryWith(query, { tab: tab.value }),
            )}
            aria-current={query.tab === tab.value ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium",
              query.tab === tab.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Workflow
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {WORKFLOWS.map((workflow) => (
              <Link
                key={workflow.value}
                href={buildRecommendationHref(
                  recommendationQueryWith(query, {
                    workflow: workflow.value,
                  }),
                )}
                aria-current={
                  query.workflow === workflow.value ? "true" : undefined
                }
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  query.workflow === workflow.value
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                )}
              >
                {workflow.label}
              </Link>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Show date
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DATE_BANDS.map((band) => (
              <Link
                key={band.value}
                href={buildRecommendationHref(
                  recommendationQueryWith(query, { dateBand: band.value }),
                )}
                title={band.description}
                aria-current={query.dateBand === band.value ? "true" : undefined}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  query.dateBand === band.value
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                )}
              >
                {band.label}
              </Link>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <h2 id="recommendation-results" className="text-lg font-semibold">
          {total} recommendation{total === 1 ? "" : "s"}
        </h2>
        <p className="text-xs text-zinc-500">
          Showing {recommendations.length}
        </p>
      </div>

      {groups.length === 0 ? (
        <Card className="mt-3">
          <CardBody>
            <p className="font-medium">No recommendations match these filters.</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Try another arm, workflow state, or date band.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="mt-3 space-y-8">
          {groups.map((group) => (
            <section key={group.date} aria-labelledby={`date-${group.date}`}>
              <div className="mb-3 flex items-center gap-3">
                <h3
                  id={`date-${group.date}`}
                  className="text-base font-semibold"
                >
                  {formatShowDate(`${group.date}T00:00:00.000Z`, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </h3>
                {new Set(group.recommendations.map((row) => row.showId)).size >
                  1 && <Badge tone="info">Same-night alternatives</Badge>}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {group.recommendations.map((recommendation) => (
                  <RecommendationCard
                    key={recommendation.identityKey}
                    recommendation={recommendation}
                    role={recommendation.sameNightRole}
                    returnTo={buildRecommendationHref(query)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="mt-6 flex min-h-10 justify-center">
        {nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : recommendations.length > 0 ? (
          <p className="text-sm text-zinc-500">You’ve reached the end.</p>
        ) : null}
      </div>
      {error && (
        <p className="mt-2 text-center text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
