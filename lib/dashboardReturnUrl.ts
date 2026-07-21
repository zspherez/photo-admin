import { sanitizeNextPath } from "@/lib/auth";
import {
  buildDashboardHref,
  parseDashboardQuery,
} from "@/lib/dashboardQuery";
import {
  firstSearchParam,
  positiveIntegerSearchParam,
  validatedTrimmedSearchParam,
} from "@/lib/searchParams";
import {
  DEFAULT_FESTIVAL_LIST_VIEW,
  festivalListPath,
  parseFestivalListView,
  type FestivalListView,
} from "@/lib/festivalView";
import {
  buildRecommendationHref,
  parseRecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";

const DASHBOARD_ORIGIN = "https://dashboard.local";
const FESTIVAL_PATH = /^\/festivals\/([A-Za-z0-9_-]+)$/;
const ARTIST_PATH = /^\/artists\/([A-Za-z0-9_-]+)$/;
const CONTACT_PATH = /^\/dashboard\/contact\/([A-Za-z0-9_-]+)$/;
const OUTREACH_STATUSES = new Set([
  "all",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "test",
  "failed",
  "manual_review",
  "retry_scheduled",
  "scheduled",
]);

export const FESTIVAL_FILTERS = [
  "all",
  "matched",
  "matched_with_contact",
  "needs_contact",
  "unsent",
] as const;

export type FestivalFilter = (typeof FESTIVAL_FILTERS)[number];

export type DashboardResultKey =
  | "added"
  | "cancelled"
  | "deleted"
  | "error"
  | "followup_scheduled"
  | "followup_sent"
  | "marked"
  | "scheduled"
  | "sent"
  | "sheet_errors"
  | "unmarked"
  | "updated";

export function parseFestivalFilter(value: unknown): FestivalFilter {
  const normalized = firstSearchParam(value);
  return normalized &&
    FESTIVAL_FILTERS.includes(normalized as FestivalFilter)
    ? (normalized as FestivalFilter)
    : "all";
}

export function parseFestivalGenre(value: unknown): string {
  const normalized = validatedTrimmedSearchParam(value, { maxLength: 80 });
  return normalized && normalized.toLowerCase() !== "all"
    ? normalized.toLowerCase()
    : "all";
}

export function festivalReturnPath(
  showId: string,
  filter: FestivalFilter = "all",
  genre: unknown = "all",
  listView: FestivalListView = DEFAULT_FESTIVAL_LIST_VIEW
): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  const normalizedGenre = parseFestivalGenre(genre);
  if (normalizedGenre !== "all") {
    params.set("genre", normalizedGenre);
  }
  if (listView.includeInternational) {
    params.set("includeInternational", "1");
  }
  if (listView.dismissed) params.set("dismissed", "1");
  const query = params.toString();
  const path = `/festivals/${encodeURIComponent(showId)}`;
  return query ? `${path}?${query}` : path;
}

function parsedLocalUrl(value: unknown): URL | null {
  const localPath = sanitizeNextPath(value);
  if (localPath === "/") return null;
  const pathEnd = localPath.search(/[?#]/);
  const rawPath = pathEnd === -1 ? localPath : localPath.slice(0, pathEnd);

  try {
    const url = new URL(localPath, DASHBOARD_ORIGIN);
    return url.origin === DASHBOARD_ORIGIN && url.pathname === rawPath
      ? url
      : null;
  } catch {
    return null;
  }
}

export function dashboardReturnPath(value: unknown): string {
  const url = parsedLocalUrl(value);
  if (!url || url.pathname !== "/dashboard") return "/dashboard";

  const searchParams: Record<string, string> = {};
  for (const [key, entryValue] of url.searchParams) {
    if (!(key in searchParams)) searchParams[key] = entryValue;
  }
  return buildDashboardHref(parseDashboardQuery(searchParams));
}

function outreachReturnPath(url: URL): string {
  const params = new URLSearchParams();
  const status = url.searchParams.get("status");
  if (status && OUTREACH_STATUSES.has(status) && status !== "all") {
    params.set("status", status);
  }
  const search = validatedTrimmedSearchParam(url.searchParams.get("search"), {
    maxLength: 200,
  });
  if (search) params.set("search", search);
  const page = positiveIntegerSearchParam(url.searchParams.get("page"));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/outreach?${query}` : "/outreach";
}

function contactsReturnPath(url: URL): string {
  const params = new URLSearchParams();
  const search = validatedTrimmedSearchParam(
    url.searchParams.get("search"),
    { maxLength: 200 }
  );
  if (search) params.set("search", search);
  const page = positiveIntegerSearchParam(url.searchParams.get("page"));
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/contacts?${query}` : "/contacts";
}

function recommendationsReturnPath(url: URL): string {
  const values: Record<string, string> = {};
  for (const key of ["tab", "workflow", "date"]) {
    const value = url.searchParams.get(key);
    if (value !== null) values[key] = value;
  }
  const path = buildRecommendationHref(parseRecommendationQuery(values));
  const returnTo = url.searchParams.get("returnTo");
  if (!returnTo) return path;
  const destination = dashboardReturnPath(returnTo);
  const recommendationUrl = new URL(path, DASHBOARD_ORIGIN);
  recommendationUrl.searchParams.set("returnTo", destination);
  return `${recommendationUrl.pathname}${recommendationUrl.search}`;
}

function nestedWorkflowReturnPath(value: unknown): string {
  const nested = parsedLocalUrl(value);
  if (
    !nested ||
    ARTIST_PATH.test(nested.pathname) ||
    CONTACT_PATH.test(nested.pathname)
  ) {
    return "/dashboard";
  }
  return workflowReturnPath(value);
}

export function workflowReturnPath(value: unknown): string {
  const url = parsedLocalUrl(value);
  if (!url) return "/dashboard";
  if (url.pathname === "/dashboard") return dashboardReturnPath(value);
  if (url.pathname === "/contacts") return contactsReturnPath(url);
  if (url.pathname === "/recommendations") {
    return recommendationsReturnPath(url);
  }
  if (url.pathname === "/outreach") return outreachReturnPath(url);
  if (url.pathname === "/festivals") {
    return festivalListPath(
      parseFestivalListView({
        includeInternational: url.searchParams.get("includeInternational"),
        dismissed: url.searchParams.get("dismissed"),
      })
    );
  }

  const artistMatch = ARTIST_PATH.exec(url.pathname);
  if (artistMatch) {
    const params = new URLSearchParams();
    const returnTo = nestedWorkflowReturnPath(
      url.searchParams.get("returnTo"),
    );
    if (returnTo !== "/dashboard") params.set("returnTo", returnTo);
    const query = params.toString();
    const path = `/artists/${encodeURIComponent(artistMatch[1])}`;
    return query ? `${path}?${query}` : path;
  }

  const contactMatch = CONTACT_PATH.exec(url.pathname);
  if (contactMatch) {
    const params = new URLSearchParams();
    const returnTo = nestedWorkflowReturnPath(
      url.searchParams.get("returnTo"),
    );
    if (returnTo !== "/dashboard") params.set("returnTo", returnTo);
    const historyPage = positiveIntegerSearchParam(
      url.searchParams.get("historyPage"),
    );
    if (historyPage > 1) params.set("historyPage", String(historyPage));
    const query = params.toString();
    const path = `/dashboard/contact/${encodeURIComponent(contactMatch[1])}`;
    return query ? `${path}?${query}` : path;
  }

  const match = FESTIVAL_PATH.exec(url.pathname);
  if (!match || match[1] === "new") return "/dashboard";
  const genre = parseFestivalGenre(url.searchParams.get("genre"));
  return festivalReturnPath(
    match[1],
    parseFestivalFilter(url.searchParams.get("filter")),
    genre,
    parseFestivalListView({
      includeInternational: url.searchParams.get("includeInternational"),
      dismissed: url.searchParams.get("dismissed"),
    })
  );
}

export function workflowFestivalShowId(value: unknown): string | null {
  const url = new URL(workflowReturnPath(value), DASHBOARD_ORIGIN);
  return FESTIVAL_PATH.exec(url.pathname)?.[1] ?? null;
}

export function appendWorkflowResult(
  returnTo: unknown,
  entries: Readonly<Record<string, string>>
): string {
  const url = new URL(workflowReturnPath(returnTo), DASHBOARD_ORIGIN);
  for (const [key, value] of Object.entries(entries)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

export function dashboardResultHref(
  returnTo: unknown,
  key: DashboardResultKey,
  value = "1"
): string {
  return appendWorkflowResult(returnTo, { [key]: value });
}

export function withWorkflowReturnTo(path: string, returnTo: unknown): string {
  const url = new URL(path, DASHBOARD_ORIGIN);
  if (url.origin !== DASHBOARD_ORIGIN || !url.pathname.startsWith("/")) {
    throw new Error("Workflow destination must be an internal path");
  }
  url.searchParams.set("returnTo", workflowReturnPath(returnTo));
  return `${url.pathname}${url.search}`;
}

export function artistWorkflowPath(
  artistId: string,
  returnTo: unknown,
  entries: Readonly<Record<string, string>> = {}
): string {
  return appendWorkflowResult(
    withWorkflowReturnTo(
      `/artists/${encodeURIComponent(artistId)}`,
      returnTo
    ),
    entries
  );
}
