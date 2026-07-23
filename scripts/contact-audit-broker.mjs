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
import { validateAuditSubmissionPayload } from "../lib/contactAgentPayloadValidation.mjs";

const baseUrl = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
const staticToken = process.env.CONTACT_AUDIT_AGENT_TOKEN?.trim();
const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim();
const oidcRequestToken =
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim();
const socketPath = process.env.CONTACT_AUDIT_BROKER_SOCKET?.trim();
const metricsFile = process.env.CONTACT_AUDIT_BROKER_METRICS_FILE?.trim();
const oidcAudience = "photo-admin-contact-audit";
const maxRequestBytes = 100_000;
const metrics = {
  claimCalls: 0,
  claimedJobs: 0,
  submissions: 0,
  artistBySession: {},
  sessions: {},
};
const sessions = new Map();

if (
  !baseUrl ||
  !socketPath ||
  (!staticToken && (!oidcRequestUrl || !oidcRequestToken))
) {
  throw new Error(
    "APP_BASE_URL, CONTACT_AUDIT_BROKER_SOCKET, and static or OIDC authentication are required"
  );
}

const sourceUrlsSchema = z.array(z.string().url()).min(1);
const nullableString = z.string().nullable();
const rosterContactSchema = z
  .object({
    rosterEntryId: z.string().min(1),
    contactId: nullableString,
    isTarget: z.boolean(),
    email: nullableString,
    phone: nullableString,
    directOutreachNote: nullableString,
    name: nullableString,
    role: nullableString,
    source: nullableString,
    notes: nullableString,
    isFullTeam: z.boolean().nullable(),
  })
  .strict();
const claimJobSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    artistId: z.string().min(1),
    claimToken: z.string().min(1),
    claimExpiresAt: z.string().datetime(),
    attemptCount: z.number().int().min(1),
    contact: z
      .object({
        artistName: z.string().min(1),
        email: nullableString,
        phone: nullableString,
        directOutreachNote: nullableString,
        name: nullableString,
        role: nullableString,
        source: nullableString,
        notes: nullableString,
        isFullTeam: z.boolean().nullable(),
      })
      .strict(),
    contactRoster: z
      .object({
        snapshotId: nullableString,
        snapshotAt: z.string().datetime().nullable(),
        completeness: z.enum(["complete", "legacy_single_contact"]),
        contacts: z
          .array(rosterContactSchema)
          .min(1)
          .refine(
            (contacts) =>
              contacts.filter((contact) => contact.isTarget).length === 1,
            "contact roster must identify exactly one target"
          ),
      })
      .strict(),
  })
  .strict();
const alternativeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().max(200).nullable().optional(),
    role: z.enum(["manager", "management"]),
    sourceUrls: sourceUrlsSchema.max(5),
    evidence: z.string().min(1).max(4_000),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();
const submitResultSchema = z
  .object({
    jobId: z.string().min(1),
    claimToken: z.string().min(1),
    finding: z.enum([
      "current",
      "changed",
      "stale",
      "ambiguous",
      "unverified",
    ]),
    sourceUrls: sourceUrlsSchema.max(10),
    evidence: z.string().min(1).max(4_000),
    confidence: z.enum(["high", "medium", "low"]),
    notes: z.string().max(4_000).nullable().optional(),
    alternatives: z.array(alternativeSchema).max(10),
    rosterReview: z
      .array(
        z
          .object({
            rosterEntryId: z.string().min(1).max(100),
            assessment: z.enum([
              "current",
              "stale",
              "coexisting",
              "conflicting",
              "unverified",
            ]),
            notes: z.string().min(1).max(1_000),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.finding === "current" && value.alternatives.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "current findings cannot include alternatives",
      });
    }
    if (value.finding === "stale" && value.alternatives.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stale findings cannot include alternatives",
      });
    }
    if (value.finding === "changed" && value.alternatives.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed findings require an alternative",
      });
    }
  });
const schemas = {
  claim: z.object({ limit: z.literal(1) }).strict(),
  search: z
    .object({
      query: z.string().min(1).max(300),
      limit: z.number().int().min(1).max(10).default(8),
    })
    .strict(),
  fetch: z.object({ url: z.string().url() }).strict(),
  "known-contacts": z
    .object({
      managerName: z.string().min(1).max(200).nullable().optional(),
      company: z.string().min(1).max(200).nullable().optional(),
      domain: z.string().min(1).max(320).nullable().optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.managerName || value.domain),
      "managerName or domain is required"
    ),
  "submit-result": submitResultSchema,
  "validate-result": submitResultSchema,
};

class BrokerConflictError extends Error {}
class BrokerInputError extends Error {}
class PhotoAdminRequestError extends Error {
  status;

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
        authorization: ["Bear", "er ", oidcRequestToken].join(""),
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
      authorization: ["Bear", "er ", token].join(""),
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
    throw new PhotoAdminRequestError(
      response.status,
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
  const temporary = `${metricsFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(metrics), { mode: 0o660 });
  chmodSync(temporary, 0o660);
  renameSync(temporary, metricsFile);
}

function sessionState(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = {
    sessionId,
    claim: null,
    completed: false,
    knownContactLookups: 0,
  };
  sessions.set(sessionId, created);
  metrics.sessions[sessionId] = {
    artist: null,
    claimed: false,
    completed: false,
    empty: false,
    stale: false,
  };
  return created;
}

function publicClaimResponse(value, state) {
  const jobs = Array.isArray(value?.jobs) ? value.jobs : [];
  if (jobs.length > 1) {
    throw new Error("photo-admin returned more than one claimed job");
  }
  if (jobs.length === 0) {
    metrics.sessions[state.sessionId].empty = true;
    return { jobs: [] };
  }
  const [job] = jobs;
  const parsedJob = claimJobSchema.parse(job);
  state.claim = {
    jobId: parsedJob.id,
    claimToken: parsedJob.claimToken,
    artistId: parsedJob.artistId,
    rosterEntryIds: parsedJob.contactRoster.contacts.map(
      (contact) => contact.rosterEntryId
    ),
  };
  metrics.artistBySession[state.sessionId] = parsedJob.contact.artistName;
  metrics.sessions[state.sessionId] = {
    artist: parsedJob.contact.artistName,
    claimed: true,
    completed: false,
    empty: false,
    stale: false,
  };
  const { id, ...fields } = parsedJob;
  return { jobs: [{ jobId: id, ...fields }] };
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

function addAuditedArtistContext(value, state) {
  const auditedArtistId = state.claim.artistId;
  const matches = Array.isArray(value?.matches) ? value.matches : [];
  return {
    ...value,
    auditedArtistId,
    matches: matches.map((match) => ({
      ...match,
      storedForAuditedArtist:
        Array.isArray(match?.artistIds) &&
        match.artistIds.includes(auditedArtistId),
    })),
  };
}

function validateClaimRosterReview(state, input) {
  const expected = state.claim.rosterEntryIds;
  const submitted = input.rosterReview.map((review) => review.rosterEntryId);
  const submittedCounts = new Map();
  for (const rosterEntryId of submitted) {
    submittedCounts.set(
      rosterEntryId,
      (submittedCounts.get(rosterEntryId) ?? 0) + 1
    );
  }
  const expectedSet = new Set(expected);
  const missing = expected.filter(
    (rosterEntryId) => !submittedCounts.has(rosterEntryId)
  );
  const unknown = [...submittedCounts.keys()].filter(
    (rosterEntryId) => !expectedSet.has(rosterEntryId)
  );
  const duplicates = [...submittedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([rosterEntryId]) => rosterEntryId);
  if (missing.length === 0 && unknown.length === 0 && duplicates.length === 0) {
    return;
  }
  throw new BrokerInputError(
    [
      "rosterReview must include every claimed rosterEntryId exactly once",
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
      unknown.length > 0 ? `unknown: ${unknown.join(", ")}` : null,
      duplicates.length > 0 ? `duplicates: ${duplicates.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ")
  );
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
      return publicClaimResponse(
        await photoAdminRequest("/api/contact-audit/claim", input),
        state
      );
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
    case "known-contacts":
      if (!state.claim || state.completed) {
        throw new BrokerConflictError(
          "known contact lookup requires one active claimed job"
        );
      }
      if (state.knownContactLookups >= 3) {
        throw new BrokerConflictError(
          "known contact lookup limit reached for this contact"
        );
      }
      state.knownContactLookups += 1;
      return addAuditedArtistContext(
        await photoAdminRequest(
          "/api/contact-audit/known-contacts",
          input
        ),
        state
      );
    case "validate-result":
      requireSessionClaim(state, input);
      try {
        validateAuditSubmissionPayload(input);
        validateClaimRosterReview(state, input);
      } catch (error) {
        throw new BrokerInputError(
          error instanceof Error ? error.message : String(error)
        );
      }
      return { ok: true };
    case "submit-result": {
      requireSessionClaim(state, input);
      try {
        validateAuditSubmissionPayload(input);
        validateClaimRosterReview(state, input);
      } catch (error) {
        throw new BrokerInputError(
          error instanceof Error ? error.message : String(error)
        );
      }
      let result;
      try {
        result = await photoAdminRequest(
          `/api/contact-audit/${encodeURIComponent(input.jobId)}/result`,
          {
            claimToken: input.claimToken,
            finding: input.finding,
            sourceUrls: input.sourceUrls,
            evidence: input.evidence,
            confidence: input.confidence,
            notes: input.notes ?? null,
            alternatives: input.alternatives,
            rosterReview: input.rosterReview,
          }
        );
      } catch (error) {
        if (
          error instanceof PhotoAdminRequestError &&
          error.status === 409
        ) {
          state.completed = true;
          metrics.sessions[sessionId].completed = true;
          metrics.sessions[sessionId].stale = true;
          persistMetrics();
        }
        throw error;
      }
      state.completed = true;
      metrics.submissions += 1;
      metrics.sessions[sessionId].completed = true;
      persistMetrics();
      return result;
    }
    default:
      throw new Error("unknown tool");
  }
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
    const sessionId = request.headers["x-contact-audit-session"];
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(sessionId)
    ) {
      sendJson(response, 400, { error: "invalid agent session" });
      return;
    }
    const input = schema.parse(await readJsonBody(request));
    const result = await runTool(name, input, sessionId);
    if (name === "claim") {
      metrics.claimCalls += 1;
      metrics.claimedJobs += Array.isArray(result?.jobs)
        ? result.jobs.length
        : 0;
      persistMetrics();
    }
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof BrokerConflictError) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    if (error instanceof BrokerInputError) {
      sendJson(response, 400, { error: error.message });
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
        event: "contact_audit_broker_tool_failed",
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
