import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
  isAuthenticated,
} from "@/lib/auth";
import { parseDashboardQuery, type DashboardQuery } from "@/lib/dashboardQuery";
import { getDashboardNextBatch, type DashboardBatch } from "@/lib/match";
import { getDashboardInteractionState } from "@/lib/dashboardInteractionState";
import type { DashboardInteractionState } from "@/lib/dashboardInteractionState";
import { serializeDashboardAppendPayload } from "@/lib/dashboardTransport";

const ALLOWED_PARAMETERS = new Set([
  "cursor",
  "mode",
  "range",
  "src",
  "contact",
  "status",
  "search",
]);
const ENUM_PARAMETERS: Record<string, ReadonlySet<string>> = {
  mode: new Set(["matched", "unknown", "interested", "dismissed"]),
  range: new Set(["7d", "30d", "30-60d", "90d"]),
  src: new Set(["any", "statsfm", "spotify"]),
  contact: new Set(["any", "has", "needs"]),
  status: new Set(["any", "unsent", "sent", "opened", "clicked"]),
};

export interface DashboardBatchRequest {
  cursor: string;
  query: DashboardQuery;
}

export function parseDashboardBatchRequest(
  url: URL
): DashboardBatchRequest | null {
  for (const key of url.searchParams.keys()) {
    if (
      !ALLOWED_PARAMETERS.has(key) ||
      url.searchParams.getAll(key).length !== 1
    ) {
      return null;
    }
  }
  const cursor = url.searchParams.get("cursor");
  if (
    !cursor ||
    cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    return null;
  }
  for (const [key, allowed] of Object.entries(ENUM_PARAMETERS)) {
    const value = url.searchParams.get(key);
    if (value !== null && !allowed.has(value)) return null;
  }
  const search = url.searchParams.get("search");
  if (
    search !== null &&
    (search.length === 0 ||
      search.length > 200 ||
      search !== search.trim() ||
      /[\u0000-\u001f\u007f-\u009f]/.test(search))
  ) {
    return null;
  }

  const query = parseDashboardQuery(
    Object.fromEntries(
      [...url.searchParams].filter(([key]) => key !== "cursor")
    )
  );
  return { cursor, query };
}

type AuthResult = "ok" | "unauthorized" | "misconfigured";

interface DashboardShowsRouteDependencies {
  authenticate: (request: NextRequest) => Promise<AuthResult>;
  loadBatch: (
    query: DashboardQuery,
    cursor: string,
    now: Date
  ) => Promise<DashboardBatch | null>;
  loadInteractionState: (
    shows: DashboardBatch["shows"],
    now: Date
  ) => Promise<DashboardInteractionState>;
  now: () => Date;
}

async function authenticate(request: NextRequest): Promise<AuthResult> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "misconfigured") return "misconfigured";
  if (configuration.mode === "open") return "ok";
  return (await isAuthenticated(
    request.cookies.get(SESSION_COOKIE)?.value
  ))
    ? "ok"
    : "unauthorized";
}

const DEFAULT_DEPENDENCIES: DashboardShowsRouteDependencies = {
  authenticate,
  loadBatch: getDashboardNextBatch,
  loadInteractionState: getDashboardInteractionState,
  now: () => new Date(),
};

export async function handleDashboardShowsRequest(
  request: NextRequest,
  dependencies: DashboardShowsRouteDependencies = DEFAULT_DEPENDENCIES
): Promise<Response> {
  const auth = await dependencies.authenticate(request);
  if (auth === "misconfigured") {
    return Response.json(
      { error: "Authentication is not configured on the server" },
      { status: 500 }
    );
  }
  if (auth !== "ok") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = parseDashboardBatchRequest(request.nextUrl);
  if (!parsed) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const requestNow = dependencies.now();
  const batch = await dependencies.loadBatch(
    parsed.query,
    parsed.cursor,
    requestNow
  );
  if (!batch) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }
  const interactionState = await dependencies.loadInteractionState(
    batch.shows,
    requestNow
  );

  return Response.json(
    serializeDashboardAppendPayload({
      shows: batch.shows,
      nextCursor: batch.nextCursor,
      ...interactionState,
    })
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await handleDashboardShowsRequest(request);
  } catch (error) {
    console.error("Dashboard show batch failed", error);
    return Response.json({ error: "Could not load shows" }, { status: 500 });
  }
}
