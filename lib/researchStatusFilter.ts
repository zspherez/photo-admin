import { firstSearchParam } from "@/lib/searchParams";

const RESEARCH_STATUS_CATEGORIES = [
  {
    key: "review",
    label: "To review",
    countLabel: "to review",
  },
  {
    key: "claimed",
    label: "Researching",
    countLabel: "researching",
  },
  {
    key: "pending",
    label: "Queued",
    countLabel: "queued",
  },
  {
    key: "complete",
    label: "Complete",
    countLabel: "complete",
  },
  {
    key: "exhausted",
    label: "Exhausted",
    countLabel: "exhausted",
  },
  {
    key: "skipped",
    label: "Skipped",
    countLabel: "skipped",
  },
] as const;

export type ResearchJobStatus =
  (typeof RESEARCH_STATUS_CATEGORIES)[number]["key"];

export const RESEARCH_JOB_STATUSES = RESEARCH_STATUS_CATEGORIES.map(
  (category) => category.key
);

export type ResearchStatusFilter = "all" | ResearchJobStatus;

const ALL_RESEARCH_JOB_STATUSES = RESEARCH_JOB_STATUSES.filter(
  (status) => status !== "skipped"
);

export const RESEARCH_STATUS_FILTER_KEYS: readonly ResearchStatusFilter[] = [
  "all",
  ...RESEARCH_JOB_STATUSES,
];

export const RESEARCH_STATUS_FILTERS: ReadonlyArray<{
  key: ResearchStatusFilter;
  label: string;
  countLabel: string;
  statuses: readonly ResearchJobStatus[];
}> = [
  {
    key: "all",
    label: "All",
    countLabel: "all",
    statuses: ALL_RESEARCH_JOB_STATUSES,
  },
  ...RESEARCH_STATUS_CATEGORIES.map((category) => ({
    ...category,
    statuses: [category.key],
  })),
];

const FILTERS_BY_KEY = new Map(
  RESEARCH_STATUS_FILTERS.map((filter) => [filter.key, filter])
);

export function parseResearchStatusFilter(
  value: unknown
): ResearchStatusFilter {
  const normalized = firstSearchParam(value);
  return normalized &&
    RESEARCH_STATUS_FILTER_KEYS.includes(
      normalized as ResearchStatusFilter
    )
    ? (normalized as ResearchStatusFilter)
    : "all";
}

export function researchStatusFilterDefinition(
  filter: ResearchStatusFilter
) {
  return FILTERS_BY_KEY.get(filter) ?? FILTERS_BY_KEY.get("all")!;
}

export function researchStatusHref(
  filter: ResearchStatusFilter,
  values: Readonly<Record<string, string>> = {}
): string {
  const params = new URLSearchParams({ status: filter, ...values });
  return `/research?${params.toString()}`;
}

export function researchStatusCounts(
  groupedCounts: ReadonlyArray<{ status: string; count: number }>
): Map<ResearchStatusFilter, number> {
  const rawCounts = new Map(
    groupedCounts.map((row) => [row.status, row.count])
  );
  return new Map(
    RESEARCH_STATUS_FILTERS.map((filter) => [
      filter.key,
      filter.statuses.reduce(
        (total, status) => total + (rawCounts.get(status) ?? 0),
        0
      ),
    ])
  );
}
