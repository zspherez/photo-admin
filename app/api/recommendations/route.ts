import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
  isAuthenticated,
} from "@/lib/auth";
import { dashboardSessionIdentity } from "@/lib/dashboardSession";
import {
  decodeRecommendationCursor,
  encodeRecommendationCursor,
  verifyRecommendationCursor,
} from "@/lib/trajectoryRecommendationCursor";
import {
  parseRecommendationQuery,
  type RecommendationQuery,
} from "@/lib/trajectoryRecommendationQuery";
import { getTrajectoryRecommendationPage } from "@/lib/trajectoryRecommendations";

const ALLOWED_PARAMETERS = new Set([
  "cursor",
  "tab",
  "workflow",
  "date",
]);

type AuthResult =
  | { status: "ok"; ownerKey: string }
  | { status: "unauthorized" | "misconfigured" };

interface ParsedBatchRequest {
  cursor: string;
  query: RecommendationQuery;
}

export function parseRecommendationBatchRequest(
  url: URL,
): ParsedBatchRequest | null {
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
    cursor.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    return null;
  }
  const values = Object.fromEntries(
    [...url.searchParams].filter(([key]) => key !== "cursor"),
  );
  const query = parseRecommendationQuery(values);
  if (
    (values.tab && values.tab !== query.tab) ||
    (values.workflow && values.workflow !== query.workflow) ||
    (values.date && values.date !== query.dateBand)
  ) {
    return null;
  }
  return { cursor, query };
}

async function authenticate(request: NextRequest): Promise<AuthResult> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "misconfigured") {
    return { status: "misconfigured" };
  }
  const cookieValue = request.cookies.get(SESSION_COOKIE)?.value;
  if (
    configuration.mode === "protected" &&
    !(await isAuthenticated(cookieValue))
  ) {
    return { status: "unauthorized" };
  }
  return {
    status: "ok",
    ownerKey: dashboardSessionIdentity(cookieValue, configuration).ownerKey,
  };
}

interface RouteDependencies {
  authenticate: (request: NextRequest) => Promise<AuthResult>;
  loadPage: typeof getTrajectoryRecommendationPage;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: RouteDependencies = {
  authenticate,
  loadPage: getTrajectoryRecommendationPage,
  now: () => new Date(),
};

export async function handleRecommendationBatchRequest(
  request: NextRequest,
  dependencies: RouteDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
  const auth = await dependencies.authenticate(request);
  if (auth.status === "misconfigured") {
    return Response.json(
      { error: "Authentication is not configured on the server" },
      { status: 500 },
    );
  }
  if (auth.status !== "ok") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = parseRecommendationBatchRequest(request.nextUrl);
  if (!parsed) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const cursor = decodeRecommendationCursor(parsed.cursor, parsed.query);
  if (
    !cursor ||
    !verifyRecommendationCursor(cursor, parsed.query, auth.ownerKey)
  ) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }
  const result = await dependencies.loadPage(parsed.query, {
    now: dependencies.now(),
    offset: cursor.offset,
    expectedRunId: cursor.runId,
  });
  if (result.availability !== "ready" || !result.run) {
    return Response.json(
      { error: "Recommendation run is no longer active" },
      { status: 410 },
    );
  }
  return Response.json({
    recommendations: result.recommendations,
    nextCursor:
      result.nextOffset === null
        ? null
        : encodeRecommendationCursor(
            result.run.id,
            result.nextOffset,
            parsed.query,
            auth.ownerKey,
          ),
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await handleRecommendationBatchRequest(request);
  } catch (error) {
    console.error("Recommendation batch failed", error);
    return Response.json(
      { error: "Could not load recommendations" },
      { status: 500 },
    );
  }
}
