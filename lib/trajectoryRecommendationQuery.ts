import {
  addDateOnlyDays,
  easternDateOnly,
  parseDateOnly,
} from "@/lib/calendarDate";
import { firstSearchParam } from "@/lib/searchParams";

export const RECOMMENDATION_TABS = [
  "suggested",
  "trajectory",
  "exploration",
  "portfolio",
  "momentum",
] as const;

export const RECOMMENDATION_WORKFLOWS = [
  "all",
  "ready",
  "needs",
  "direct",
  "interested",
  "sent",
  "opened",
  "clicked",
  "dismissed",
] as const;

export const RECOMMENDATION_DATE_BANDS = [
  "all",
  "5-10",
  "10-45",
  "45-90",
] as const;

export type RecommendationTab = (typeof RECOMMENDATION_TABS)[number];
export type RecommendationWorkflow =
  (typeof RECOMMENDATION_WORKFLOWS)[number];
export type RecommendationDateBand =
  (typeof RECOMMENDATION_DATE_BANDS)[number];

export interface RecommendationQuery {
  tab: RecommendationTab;
  workflow: RecommendationWorkflow;
  dateBand: RecommendationDateBand;
}

type SearchParamsRecord = Record<string, string | string[] | undefined>;

export const DEFAULT_RECOMMENDATION_QUERY: RecommendationQuery = {
  tab: "suggested",
  workflow: "all",
  dateBand: "all",
};

function includes<T extends string>(
  values: readonly T[],
  value: string | undefined,
): value is T {
  return value !== undefined && values.some((item) => item === value);
}

export function parseRecommendationQuery(
  searchParams: SearchParamsRecord,
): RecommendationQuery {
  const tab = firstSearchParam(searchParams.tab);
  const workflow = firstSearchParam(searchParams.workflow);
  const dateBand = firstSearchParam(searchParams.date);
  return {
    tab: includes(RECOMMENDATION_TABS, tab)
      ? tab
      : DEFAULT_RECOMMENDATION_QUERY.tab,
    workflow: includes(RECOMMENDATION_WORKFLOWS, workflow)
      ? workflow
      : DEFAULT_RECOMMENDATION_QUERY.workflow,
    dateBand: includes(RECOMMENDATION_DATE_BANDS, dateBand)
      ? dateBand
      : DEFAULT_RECOMMENDATION_QUERY.dateBand,
  };
}

export function buildRecommendationHref(
  query: RecommendationQuery,
  pathname = "/recommendations",
  returnTo?: string | null,
): string {
  const params = new URLSearchParams();
  if (query.tab !== DEFAULT_RECOMMENDATION_QUERY.tab) {
    params.set("tab", query.tab);
  }
  if (query.workflow !== DEFAULT_RECOMMENDATION_QUERY.workflow) {
    params.set("workflow", query.workflow);
  }
  if (query.dateBand !== DEFAULT_RECOMMENDATION_QUERY.dateBand) {
    params.set("date", query.dateBand);
  }
  if (returnTo) params.set("returnTo", returnTo);
  const queryString = params.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function buildRecommendationBatchHref(
  query: RecommendationQuery,
  cursor: string,
): string {
  const url = new URL(
    buildRecommendationHref(query, "/api/recommendations"),
    "https://recommendations.local",
  );
  url.searchParams.set("cursor", cursor);
  return `${url.pathname}${url.search}`;
}

export function recommendationDateRange(
  band: RecommendationDateBand,
  now: Date,
  minimumShowDate: Date,
): { start: Date; endExclusive: Date } {
  const today = easternDateOnly(now);
  const offsets: Record<
    RecommendationDateBand,
    { start: number; endExclusive: number }
  > = {
    all: { start: 5, endExclusive: 91 },
    "5-10": { start: 5, endExclusive: 10 },
    "10-45": { start: 10, endExclusive: 45 },
    "45-90": { start: 45, endExclusive: 91 },
  };
  const selected = offsets[band];
  const bandStart = parseDateOnly(addDateOnlyDays(today, selected.start));
  const start =
    minimumShowDate.getTime() > bandStart.getTime()
      ? minimumShowDate
      : bandStart;
  return {
    start,
    endExclusive: parseDateOnly(
      addDateOnlyDays(today, selected.endExclusive),
    ),
  };
}

export function recommendationQueryWith(
  query: RecommendationQuery,
  changes: Partial<RecommendationQuery>,
): RecommendationQuery {
  return { ...query, ...changes };
}
