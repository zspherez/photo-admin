import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  getAuthConfiguration,
  getSessionAccess,
} from "@/lib/auth";
import { loadTextMessageDraft } from "@/lib/textMessageDraft";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
type TextDraftAuth =
  | "admin"
  | "read_only"
  | "unauthorized"
  | "misconfigured";

interface TextDraftRouteDependencies {
  authenticate(request: NextRequest): Promise<TextDraftAuth>;
  loadDraft(input: {
    showId: string;
    artistId: string;
    phoneContactId: string;
  }): Promise<string | null>;
}

const DEFAULT_DEPENDENCIES: TextDraftRouteDependencies = {
  authenticate: async (request) => {
    const configuration = getAuthConfiguration();
    if (configuration.mode === "misconfigured") return "misconfigured";
    if (configuration.mode === "open") return "admin";
    return (
      (await getSessionAccess(
        request.cookies.get(SESSION_COOKIE)?.value,
      )) ?? "unauthorized"
    );
  },
  loadDraft: loadTextMessageDraft,
};

export async function handleTextDraftRequest(
  request: NextRequest,
  dependencies: TextDraftRouteDependencies = DEFAULT_DEPENDENCIES,
): Promise<Response> {
  const access = await dependencies.authenticate(request);
  if (access === "misconfigured") {
    return Response.json(
      { error: "Authentication is not configured on the server" },
      { status: 500 },
    );
  }
  if (access === "unauthorized") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (access === "read_only") {
    return Response.json(
      { error: "Text drafts are unavailable in read-only mode" },
      { status: 403 },
    );
  }

  const showId = request.nextUrl.searchParams.get("showId")?.trim() ?? "";
  const artistId = request.nextUrl.searchParams.get("artistId")?.trim() ?? "";
  const phoneContactId =
    request.nextUrl.searchParams.get("phoneContactId")?.trim() ?? "";
  if (
    !IDENTIFIER_PATTERN.test(showId) ||
    !IDENTIFIER_PATTERN.test(artistId) ||
    !IDENTIFIER_PATTERN.test(phoneContactId)
  ) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const body = await dependencies.loadDraft({
    showId,
    artistId,
    phoneContactId,
  });
  if (!body) {
    return Response.json(
      { error: "No textable contact or show context was found" },
      { status: 404 },
    );
  }
  return Response.json(
    { body },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await handleTextDraftRequest(request);
  } catch (error) {
    console.error(
      "Text draft generation failed",
      error instanceof Error ? error.message : String(error),
    );
    return Response.json(
      { error: "Could not create text draft" },
      { status: 500 },
    );
  }
}
