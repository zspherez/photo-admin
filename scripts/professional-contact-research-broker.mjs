import {
  chmodSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { z } from "zod";
import {
  fetchReadablePage,
  searchWeb,
} from "./contact-research-web.mjs";

const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
const staticToken =
  process.env.PROFESSIONAL_CONTACT_RESEARCH_AGENT_TOKEN?.trim();
const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
const oidcRequestToken =
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
const socketPath =
  process.env.PROFESSIONAL_CONTACT_RESEARCH_BROKER_SOCKET?.trim();
const metricsFile =
  process.env.PROFESSIONAL_CONTACT_RESEARCH_BROKER_METRICS_FILE?.trim();
const oidcAudience = "photo-admin-professional-contact-research";
const sessions = new Map();
const metrics = { sessions: {} };

if (
  !baseUrl ||
  !socketPath ||
  (!staticToken && (!oidcRequestUrl || !oidcRequestToken))
) {
  throw new Error(
    "APP_BASE_URL, broker socket, and static or OIDC authentication are required",
  );
}

const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"));
const candidateSchema = z
  .object({
    email: z.string().email().max(320),
    personName: z.string().min(1).max(120),
    roleTitle: z.string().min(1).max(200),
    organization: z.string().min(1).max(200),
    confidence: z.enum(["high", "medium", "low"]),
    discoveryMethod: z.enum([
      "official",
      "professional_profile",
      "business_directory",
      "domain_pattern",
    ]),
    evidence: z.string().min(80).max(4_000),
    sourceUrls: z.array(httpsUrl).min(1).max(5),
    patternEvidence: z.string().min(40).max(2_000).nullable(),
    patternEvidenceUrl: httpsUrl.nullable(),
  })
  .strict();
const submissionBase = {
  jobId: z.string().min(1).max(200),
  claimToken: z.string().uuid(),
};
const schemas = {
  claim: z.object({ limit: z.literal(1) }).strict(),
  search: z
    .object({
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(10).default(8),
    })
    .strict(),
  fetch: z.object({ url: httpsUrl }).strict(),
  "submit-candidates": z
    .object({
      ...submissionBase,
      notes: z.string().max(4_000).nullable().optional(),
      candidates: z.array(candidateSchema).min(1).max(5),
    })
    .strict(),
  "submit-exhausted": z
    .object({
      ...submissionBase,
      notes: z.string().min(80).max(4_000),
    })
    .strict(),
  "validate-result": z
    .object({
      action: z.enum(["submit-candidates", "submit-exhausted"]),
      payload: z.unknown(),
    })
    .strict(),
};

class BrokerConflictError extends Error {}
class PhotoAdminRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function authorizationToken() {
  if (oidcRequestUrl && oidcRequestToken) {
    const url = new URL(oidcRequestUrl);
    url.searchParams.set("audience", oidcAudience);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${oidcRequestToken}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub Actions OIDC returned ${response.status}`);
    }
    const data = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.value !== "string" ||
      !data.value
    ) {
      throw new Error("GitHub Actions OIDC response omitted value");
    }
    return data.value;
  }
  return staticToken;
}

async function photoAdminRequest(path, body) {
  const token = await authorizationToken();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: "invalid response" };
  }
  if (!response.ok) {
    throw new PhotoAdminRequestError(
      response.status,
      `photo-admin returned ${response.status}: ${
        typeof data.error === "string" ? data.error : "request failed"
      }`,
    );
  }
  return data;
}

function persistMetrics() {
  if (!metricsFile) return;
  const temporary = `${metricsFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(metrics), { mode: 0o660 });
  chmodSync(temporary, 0o660);
  renameSync(temporary, metricsFile);
}

function stateFor(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const state = { claim: null, completed: false };
  sessions.set(sessionId, state);
  metrics.sessions[sessionId] = {
    artist: null,
    claimed: false,
    completed: false,
    empty: false,
    stale: false,
  };
  return state;
}

function requireClaim(state, input) {
  if (
    !state.claim ||
    state.completed ||
    input.jobId !== state.claim.jobId ||
    input.claimToken !== state.claim.claimToken
  ) {
    throw new BrokerConflictError(
      "submission must use this session's active jobId and claimToken",
    );
  }
}

async function runTool(name, input, sessionId) {
  const state = stateFor(sessionId);
  if (name === "claim") {
    if (state.claim) throw new BrokerConflictError("claim may only run once");
    const result = await photoAdminRequest(
      "/api/professional-contact-research/claim",
      input,
    );
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    if (jobs.length === 0) {
      metrics.sessions[sessionId].empty = true;
      persistMetrics();
      return { jobs: [] };
    }
    if (jobs.length !== 1) throw new Error("claim returned an invalid job count");
    const [job] = jobs;
    if (
      typeof job.jobId !== "string" ||
      typeof job.claimToken !== "string" ||
      typeof job.personName !== "string"
    ) {
      throw new Error("claim returned an invalid job");
    }
    state.claim = { jobId: job.jobId, claimToken: job.claimToken };
    metrics.sessions[sessionId] = {
      artist: job.personName,
      claimed: true,
      completed: false,
      empty: false,
      stale: false,
    };
    persistMetrics();
    return { jobs: [job] };
  }
  if (!state.claim || state.completed) {
    throw new BrokerConflictError(`${name} requires an active claimed job`);
  }
  if (name === "search") return searchWeb(input.query, input.limit);
  if (name === "fetch") return fetchReadablePage(input.url);
  if (name === "validate-result") {
    const payload = schemas[input.action].parse(input.payload);
    requireClaim(state, payload);
    return { ok: true, action: input.action };
  }
  requireClaim(state, input);
  const body =
    name === "submit-candidates"
      ? {
          outcome: "candidates",
          claimToken: input.claimToken,
          notes: input.notes ?? null,
          candidates: input.candidates,
        }
      : {
          outcome: "exhausted",
          claimToken: input.claimToken,
          notes: input.notes,
          candidates: [],
        };
  try {
    const result = await photoAdminRequest(
      `/api/professional-contact-research/${encodeURIComponent(input.jobId)}/result`,
      body,
    );
    state.completed = true;
    metrics.sessions[sessionId].completed = true;
    persistMetrics();
    return result;
  } catch (error) {
    if (error instanceof PhotoAdminRequestError && error.status === 409) {
      state.completed = true;
      metrics.sessions[sessionId].completed = true;
      metrics.sessions[sessionId].stale = true;
      persistMetrics();
    }
    throw error;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 100_000) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  const name = request.url?.replace(/^\/+/, "");
  const schema = schemas[name];
  if (!schema) {
    sendJson(response, 404, { error: "unknown tool" });
    return;
  }
  try {
    const sessionId = request.headers["x-professional-contact-session"];
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(sessionId)
    ) {
      sendJson(response, 400, { error: "invalid agent session" });
      return;
    }
    const input = schema.parse(await readJsonBody(request));
    sendJson(response, 200, await runTool(name, input, sessionId));
  } catch (error) {
    if (error instanceof BrokerConflictError) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    console.error(
      JSON.stringify({
        event: "professional_contact_broker_tool_failed",
        tool: name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    sendJson(response, 502, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o660);
  persistMetrics();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
