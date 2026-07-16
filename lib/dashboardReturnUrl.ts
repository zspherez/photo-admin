import { sanitizeNextPath } from "@/lib/auth";
import {
  buildDashboardHref,
  parseDashboardQuery,
} from "@/lib/dashboardQuery";
import {
  firstSearchParam,
  validatedTrimmedSearchParam,
} from "@/lib/searchParams";

const DASHBOARD_ORIGIN = "https://dashboard.local";
const FESTIVAL_PATH = /^\/festivals\/([A-Za-z0-9_-]+)$/;

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
  genre: unknown = "all"
): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  const normalizedGenre = parseFestivalGenre(genre);
  if (normalizedGenre !== "all") {
    params.set("genre", normalizedGenre);
  }
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

export function workflowReturnPath(value: unknown): string {
  const url = parsedLocalUrl(value);
  if (!url) return "/dashboard";
  if (url.pathname === "/dashboard") return dashboardReturnPath(value);

  const match = FESTIVAL_PATH.exec(url.pathname);
  if (!match || match[1] === "new") return "/dashboard";
  const genre = parseFestivalGenre(url.searchParams.get("genre"));
  return festivalReturnPath(
    match[1],
    parseFestivalFilter(url.searchParams.get("filter")),
    genre
  );
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
