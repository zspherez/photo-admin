import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { z } from "zod";
import {
  fetchReadablePage,
  searchWeb,
} from "./contact-research-web.mjs";

const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
const staticToken = process.env.CONTACT_RESEARCH_AGENT_TOKEN?.trim();
const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
const oidcRequestToken =
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
const socketPath = process.env.CONTACT_RESEARCH_BROKER_SOCKET?.trim();
const metricsFile = process.env.CONTACT_RESEARCH_BROKER_METRICS_FILE?.trim();
const oidcAudience = "photo-admin-contact-research";
const maxRequestBytes = 100_000;
const metrics = {
  claimCalls: 0,
  claimedJobs: 0,
  submissions: 0,
};
const sessions = new Map();

if (
  !baseUrl ||
  !socketPath ||
  (!staticToken && (!oidcRequestUrl || !oidcRequestToken))
) {
  throw new Error(
    "APP_BASE_URL, CONTACT_RESEARCH_BROKER_SOCKET, and static or OIDC authentication are required"
  );
}

const candidateSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable().optional(),
  sourceUrls: z.array(z.string().url()).min(1).max(5),
  evidence: z.string().min(1).max(4_000),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

const schemas = {
  claim: z.object({
    limit: z.literal(1),
  }).strict(),
  search: z.object({
    query: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(10).default(8),
  }).strict(),
  fetch: z.object({
    url: z.string().url(),
  }).strict(),
  "submit-candidates": z.object({
    jobId: z.string().min(1),
    claimToken: z.string().min(1),
    notes: z.string().max(4_000).nullable().optional(),
    candidates: z.array(candidateSchema).min(1).max(10),
  }).strict(),
  "submit-exhausted": z.object({
    jobId: z.string().min(1),
    claimToken: z.string().min(1),
    notes: z.string().min(1).max(4_000),
  }).strict(),
};

class BrokerConflictError extends Error {}

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
      typeof data !== "object" ||
      data === null ||
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
    data = { error: text.slice(0, 500) || "invalid response" };
  }
  if (!response.ok) {
    throw new Error(
      `photo-admin returned ${response.status}: ${
        typeof data.error === "string" ? data.error : "request failed"
      }`
    );
  }
  return data;
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxRequestBytes) throw new Error("request body is too large");
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

function persistMetrics() {
  if (!metricsFile) return;
  writeFileSync(metricsFile, JSON.stringify(metrics), { mode: 0o660 });
  chmodSync(metricsFile, 0o660);
}

function recordSuccessfulTool(name, value) {
  if (name === "claim") {
    metrics.claimCalls += 1;
    metrics.claimedJobs += Array.isArray(value?.jobs)
      ? value.jobs.length
      : 0;
  }
  if (
    name === "submit-candidates" ||
    name === "submit-exhausted"
  ) {
    metrics.submissions += 1;
  }
  persistMetrics();
}

function sessionState(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = { claim: null, completed: false };
  sessions.set(sessionId, created);
  return created;
}

function publicClaimResponse(value, state) {
  const jobs = Array.isArray(value?.jobs) ? value.jobs : [];
  if (jobs.length > 1) {
    throw new Error("photo-admin returned more than one claimed job");
  }
  if (jobs.length === 0) return { jobs: [] };
  const [job] = jobs;
  const {
    id,
    artist,
    ...jobFields
  } = job;
  if (
    typeof id !== "string" ||
    typeof job.claimToken !== "string" ||
    !artist ||
    typeof artist !== "object"
  ) {
    throw new Error("photo-admin returned an invalid claimed job");
  }
  const artistFields = { ...artist };
  delete artistFields.id;
  state.claim = { jobId: id, claimToken: job.claimToken };
  return {
    jobs: [
      {
        jobId: id,
        ...jobFields,
        artist: artistFields,
      },
    ],
  };
}

function requireSessionClaim(state, input) {
  if (!state.claim || state.completed) {
    throw new BrokerConflictError("session has no active claimed job");
  }
  if (
    input.jobId !== state.claim.jobId ||
    input.claimToken !== state.claim.claimToken
  ) {
    throw new BrokerConflictError(
      "submission must use the top-level jobId and claimToken from this session"
    );
  }
}

async function runTool(name, input, sessionId) {
  const state = sessionState(sessionId);
  switch (name) {
    case "claim": {
      if (state.claim) {
        throw new BrokerConflictError(
          "claim may only be called once per agent session"
        );
      }
      const result = await photoAdminRequest(
        "/api/contact-research/claim",
        input
      );
      return publicClaimResponse(result, state);
    }
    case "search":
      if (!state.claim || state.completed) {
        throw new BrokerConflictError(
          "search requires one active claimed job"
        );
      }
      return searchWeb(input.query, input.limit);
    case "fetch":
      if (!state.claim || state.completed) {
        throw new BrokerConflictError(
          "fetch requires one active claimed job"
        );
      }
      return fetchReadablePage(input.url);
    case "submit-candidates": {
      requireSessionClaim(state, input);
      const result = await photoAdminRequest(
        `/api/contact-research/${encodeURIComponent(input.jobId)}/result`,
        {
          outcome: "candidates",
          claimToken: input.claimToken,
          notes: input.notes ?? null,
          candidates: input.candidates.map((candidate) => ({
            ...candidate,
            role: "management",
          })),
        }
      );
      state.completed = true;
      return result;
    }
    case "submit-exhausted": {
      requireSessionClaim(state, input);
      const result = await photoAdminRequest(
        `/api/contact-research/${encodeURIComponent(input.jobId)}/result`,
        {
          outcome: "exhausted",
          claimToken: input.claimToken,
          notes: input.notes,
        }
      );
      state.completed = true;
      return result;
    }
    default:
      throw new Error("unknown tool");
  }
}

const server = createServer(async (request, response) => {
  if (
    request.method !== "POST"
  ) {
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
    const sessionId = request.headers["x-contact-research-session"];
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(sessionId)
    ) {
      sendJson(response, 400, { error: "invalid agent session" });
      return;
    }
    const input = schema.parse(await readJsonBody(request));
    const result = await runTool(name, input, sessionId);
    recordSuccessfulTool(name, result);
    sendJson(response, 200, result);
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
        event: "contact_research_broker_tool_failed",
        tool: name,
        error: error instanceof Error ? error.message : String(error),
      })
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
