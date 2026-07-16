import { firstSearchParam } from "@/lib/searchParams";

export { firstSearchParam } from "@/lib/searchParams";

export const DASHBOARD_PAGE_SIZE = 24;

export type RangeFilter = "7d" | "30d" | "30-60d" | "90d";
export type SourceFilter = "any" | "statsfm" | "spotify";
export type ContactFilter = "any" | "has" | "needs";
export type StatusFilter = "any" | "unsent" | "sent" | "opened" | "clicked";
export type DashboardMode =
  | "matched"
  | "unknown"
  | "interested"
  | "dismissed";

export interface MatchFilters {
  range: RangeFilter;
  source: SourceFilter;
  contact: ContactFilter;
  status: StatusFilter;
  search: string;
}

export interface DashboardQuery {
  mode: DashboardMode;
  filters: MatchFilters;
  page: number;
}

export interface DashboardPagination {
  requestedPage: number;
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export const DEFAULT_FILTERS: MatchFilters = {
  range: "90d",
  source: "any",
  contact: "any",
  status: "any",
  search: "",
};

type SearchParamsRecord = Record<string, string | string[] | undefined>;

function parsePage(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / DASHBOARD_PAGE_SIZE);
  return Number.isSafeInteger(page) && page <= maxPage ? page : 1;
}

export function parseDashboardQuery(
  searchParams: SearchParamsRecord
): DashboardQuery {
  const range = firstSearchParam(searchParams.range);
  const source = firstSearchParam(searchParams.src);
  const contact = firstSearchParam(searchParams.contact);
  const status = firstSearchParam(searchParams.status);
  const mode = firstSearchParam(searchParams.mode);

  const parsedMode: DashboardMode =
    mode === "unknown" || mode === "interested" || mode === "dismissed"
      ? mode
      : "matched";
  const parsedSource: SourceFilter =
    source === "statsfm" || source === "spotify" || source === "any"
      ? source
      : DEFAULT_FILTERS.source;

  return {
    mode: parsedMode,
    filters: {
      range:
        range === "7d" ||
        range === "30d" ||
        range === "30-60d" ||
        range === "90d"
          ? range
          : DEFAULT_FILTERS.range,
      source: parsedMode === "unknown" ? "any" : parsedSource,
      contact:
        contact === "has" || contact === "needs" || contact === "any"
          ? contact
          : DEFAULT_FILTERS.contact,
      status:
        status === "unsent" ||
        status === "sent" ||
        status === "opened" ||
        status === "clicked" ||
        status === "any"
          ? status
          : DEFAULT_FILTERS.status,
      search: (firstSearchParam(searchParams.search) ?? "").trim(),
    },
    page: parsePage(firstSearchParam(searchParams.page)),
  };
}

export function buildDashboardHref(query: DashboardQuery): string {
  const params = new URLSearchParams();
  if (query.mode !== "matched") params.set("mode", query.mode);
  if (query.filters.range !== DEFAULT_FILTERS.range) {
    params.set("range", query.filters.range);
  }
  if (
    query.mode !== "unknown" &&
    query.filters.source !== DEFAULT_FILTERS.source
  ) {
    params.set("src", query.filters.source);
  }
  if (query.filters.contact !== DEFAULT_FILTERS.contact) {
    params.set("contact", query.filters.contact);
  }
  if (query.filters.status !== DEFAULT_FILTERS.status) {
    params.set("status", query.filters.status);
  }
  if (query.filters.search) params.set("search", query.filters.search);
  if (query.page > 1) params.set("page", String(query.page));
  const queryString = params.toString();
  return queryString ? `/dashboard?${queryString}` : "/dashboard";
}

export function getPagination(
  total: number,
  requestedPage: number,
  pageSize: number = DASHBOARD_PAGE_SIZE
): DashboardPagination {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Pagination total must be a non-negative integer");
  }
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) {
    throw new Error("Pagination page must be a positive integer");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Pagination page size must be a positive integer");
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return {
    requestedPage,
    page,
    pageSize,
    pageCount,
    total,
    start,
    end,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}
