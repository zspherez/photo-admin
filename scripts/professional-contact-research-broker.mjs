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
import {
  canonicalPublicHttpsUrl,
  normalizedIdentityTokens,
  validateProfessionalContactProvenance,
} from "../lib/professionalContactProvenance.mjs";
import {
  buildFetchedSourceRecord,
  claimBoundPrimaryEntityTokens,
  emailAssociation,
  ownershipStatement,
} from "./professional-contact-provenance.mjs";

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
    patternExamples: z
      .array(
        z
          .object({
            email: z.string().email().max(320),
            personName: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(5),
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
    const code =
      data &&
      typeof data === "object" &&
      typeof data.code === "string"
        ? ` ${data.code}`
        : "";
    throw new PhotoAdminRequestError(
      response.status,
      `photo-admin returned ${response.status}${code}: ${
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
  const state = {
    claim: null,
    claimContext: null,
    completed: false,
    searches: [],
    fetchedSources: new Map(),
  };
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

function recordSearch(state, query, results) {
  if (state.searches.length >= 20) {
    throw new BrokerConflictError("search limit reached for this claim");
  }
  state.searches.push({
    query,
    resultUrls: results.flatMap((result) => {
      try {
        return [canonicalPublicHttpsUrl(result.url)];
      } catch {
        return [];
      }
    }).slice(0, 10),
  });
}

function recordFetch(state, result) {
  const source = buildFetchedSourceRecord(result);
  if (
    !state.fetchedSources.has(source.url) &&
    state.fetchedSources.size >= 12
  ) {
    throw new BrokerConflictError("fetch limit reached for this claim");
  }
  state.fetchedSources.set(source.url, source);
}

function brokerProvenance(state, submission) {
  if (!state.claim?.provenanceToken || !state.claimContext) {
    throw new BrokerConflictError("claim provenance is unavailable");
  }
  const relevantEmails = new Set();
  const relevantDomains = new Set();
  const identityByEmail = new Map();
  const relevantTokens = new Set([
    ...normalizedIdentityTokens(state.claimContext.personName),
    ...normalizedIdentityTokens(state.claimContext.organizationName),
  ]);
  const selectedUrls = new Set();
  if (submission.outcome === "candidates") {
    for (const candidate of submission.candidates) {
      relevantEmails.add(candidate.email.toLowerCase());
      relevantDomains.add(candidate.email.toLowerCase().split("@").at(-1));
      identityByEmail.set(candidate.email.toLowerCase(), {
        personName: state.claimContext.personName,
        organizationName: state.claimContext.organizationName,
        roleTitle: candidate.roleTitle,
      });
      normalizedIdentityTokens(candidate.roleTitle).forEach((token) =>
        relevantTokens.add(token),
      );
      candidate.sourceUrls.forEach((url) =>
        selectedUrls.add(canonicalPublicHttpsUrl(url)),
      );
      for (const example of candidate.patternExamples) {
        relevantEmails.add(example.email.toLowerCase());
        relevantDomains.add(example.email.toLowerCase().split("@").at(-1));
        identityByEmail.set(example.email.toLowerCase(), {
          personName: example.personName,
          organizationName: state.claimContext.organizationName,
          roleTitle: null,
        });
        normalizedIdentityTokens(example.personName).forEach((token) =>
          relevantTokens.add(token),
        );
      }
    }
  } else {
    for (const url of state.fetchedSources.keys()) selectedUrls.add(url);
  }
  const provenance = {
    claimProvenanceToken: state.claim.provenanceToken,
    searches: state.searches,
    fetchedSources: [...selectedUrls].map((url) => {
      const source = state.fetchedSources.get(url);
      if (!source) {
        throw new BrokerConflictError(
          "every submitted source URL must be fetched in this claim",
        );
      }
      return {
        url: source.url,
        contentSha256: source.contentSha256,
        primaryEntityTokens: claimBoundPrimaryEntityTokens(source),
        observedEmails: source.observedEmails.filter((email) =>
          relevantEmails.has(email),
        ),
        observedDomains: source.observedDomains.filter((domain) =>
          [...relevantDomains].some(
            (relevant) =>
              relevant &&
              (domain === relevant ||
                domain.endsWith(`.${relevant}`) ||
                relevant.endsWith(`.${domain}`)),
          ),
        ),
        emailAssociations: [...relevantEmails].flatMap((email) => {
          const identity = identityByEmail.get(email);
          if (!identity) return [];
          const association = emailAssociation(source, email, identity);
          if (!association) return [];
          return [{
            email: association.email,
            excerptSha256: association.excerptSha256,
            contentTokens: association.contentTokens.filter((token) =>
              relevantTokens.has(token),
            ),
          }];
        }),
        ownershipStatements: [...relevantDomains].flatMap((domain) => {
          if (!domain) return [];
          const statement = ownershipStatement(
            source,
            domain,
          );
          if (!statement) return [];
          return [{
            domain: statement.domain,
            blockSha256: statement.blockSha256,
            entityTokens: [...statement.entityTokens],
            contentTokens: [...statement.contentTokens],
          }];
        }),
        contentTokens: source.contentTokens.filter((token) =>
          relevantTokens.has(token),
        ),
      };
    }),
  };
  validateProfessionalContactProvenance(
    submission,
    provenance,
    {
      claimProvenanceToken: state.claim.provenanceToken,
      personName: state.claimContext.personName,
      organizationName: state.claimContext.organizationName,
      website: state.claimContext.website,
    },
  );
  return provenance;
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
      typeof job.provenanceToken !== "string" ||
      typeof job.personName !== "string" ||
      !job.request ||
      typeof job.request !== "object" ||
      typeof job.request.organizationName !== "string"
    ) {
      throw new Error("claim returned an invalid job");
    }
    state.claim = {
      jobId: job.jobId,
      claimToken: job.claimToken,
      provenanceToken: job.provenanceToken,
    };
    state.claimContext = {
      personName: job.personName,
      organizationName: job.request?.organizationName,
      website: job.request?.website ?? null,
    };
    metrics.sessions[sessionId] = {
      artist: job.personName,
      claimed: true,
      completed: false,
      empty: false,
      stale: false,
    };
    persistMetrics();
    const publicJob = { ...job };
    delete publicJob.provenanceToken;
    return { jobs: [publicJob] };
  }
  if (!state.claim || state.completed) {
    throw new BrokerConflictError(`${name} requires an active claimed job`);
  }
  if (name === "search") {
    const result = await searchWeb(input.query, input.limit);
    recordSearch(state, input.query, result);
    return result;
  }
  if (name === "fetch") {
    const result = await fetchReadablePage(input.url);
    recordFetch(state, result);
    return result;
  }
  if (name === "validate-result") {
    const payload = schemas[input.action].parse(input.payload);
    requireClaim(state, payload);
    const submission =
      input.action === "submit-candidates"
        ? { outcome: "candidates", ...payload }
        : { outcome: "exhausted", ...payload, candidates: [] };
    brokerProvenance(state, submission);
    return { ok: true, action: input.action };
  }
  requireClaim(state, input);
  const submission =
    name === "submit-candidates"
      ? { outcome: "candidates", ...input }
      : { outcome: "exhausted", ...input, candidates: [] };
  const provenance = brokerProvenance(state, submission);
  const body =
    name === "submit-candidates"
      ? {
          outcome: "candidates",
          claimToken: input.claimToken,
          notes: input.notes ?? null,
          candidates: input.candidates,
          provenance,
        }
      : {
          outcome: "exhausted",
          claimToken: input.claimToken,
          notes: input.notes,
          candidates: [],
          provenance,
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
