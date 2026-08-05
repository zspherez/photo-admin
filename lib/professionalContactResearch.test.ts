import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  type ProfessionalContactTransactionRunner,
  claimProfessionalContactJobs,
  createProfessionalContactRequest,
  decideProfessionalContactCandidate,
  dispatchProfessionalContactRequest,
  isTrustedProfessionalContactOidcClaims,
  isValidProfessionalContactAuthorization,
  parseProfessionalContactClaimLimit,
  parseProfessionalContactSubmission,
  PROFESSIONAL_CONTACT_OIDC_AUDIENCE,
  PROFESSIONAL_CONTACT_WORKFLOW_REF,
  requeueProfessionalContactJob,
  resolveProfessionalContactDispatchTarget,
  submitProfessionalContactResult,
} from "./professionalContactResearch";

function transactionRunner(tx: unknown): ProfessionalContactTransactionRunner {
  return async (work) => work(tx as Prisma.TransactionClient);
}

const validCandidate = {
  email: "jane.doe@ledpresents.com",
  personName: "Jane Doe",
  roleTitle: "Founder",
  organization: "LED Presents",
  confidence: "high",
  discoveryMethod: "official",
  evidence:
    "LED Presents identifies founder Jane Doe and publishes jane.doe@ledpresents.com as her professional business email on the official team page.",
  sourceUrls: ["https://ledpresents.com/team/jane-doe"],
  patternEvidence: null,
  patternEvidenceUrl: null,
  patternExamples: [],
} as const;

const claimProvenanceToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const validProvenance = {
  claimProvenanceToken,
  searches: [
    {
      query: "\"Jane Doe\" \"LED Presents\"",
      resultUrls: ["https://ledpresents.com/team/jane-doe"],
    },
  ],
  fetchedSources: [
    {
      url: "https://ledpresents.com/team/jane-doe",
      contentSha256: "a".repeat(64),
      observedEmails: ["jane.doe@ledpresents.com"],
      observedDomains: ["ledpresents.com"],
      emailAssociations: [
        {
          email: "jane.doe@ledpresents.com",
          excerptSha256: "b".repeat(64),
          contentTokens: ["jane", "doe", "founder"],
        },
      ],
      ownershipStatements: [],
      contentTokens: ["led", "presents", "jane", "doe", "founder"],
    },
  ],
};
const validSubmission = {
  outcome: "candidates",
  claimToken: "11111111-1111-4111-8111-111111111111",
  notes: "Official team page.",
  candidates: [validCandidate],
  provenance: validProvenance,
} as const;

test("workflow dispatch target stays aligned with trusted OIDC workflow refs", () => {
  assert.deepEqual(resolveProfessionalContactDispatchTarget(), {
    workflowFile: "professional-contact-research.yml",
    ref: "main",
    workflowRef:
      "zspherez/photo-admin/.github/workflows/professional-contact-research.yml@refs/heads/main",
  });
  assert.deepEqual(
    resolveProfessionalContactDispatchTarget({
      repository: "zspherez/photo-admin",
      owner: "zspherez",
      workflowRef:
        "zspherez/photo-admin/.github/workflows/custom-professional-worker.yaml@refs/heads/main",
    }),
    {
      workflowFile: "custom-professional-worker.yaml",
      ref: "main",
      workflowRef:
        "zspherez/photo-admin/.github/workflows/custom-professional-worker.yaml@refs/heads/main",
    },
  );
  assert.throws(
    () =>
      resolveProfessionalContactDispatchTarget({
        repository: "other/repo",
        owner: "other",
        workflowRef:
          "other/repo/.github/workflows/professional-contact-research.yml@refs/heads/main",
      }),
    /trust is not configured/,
  );
});

test("form submission durably creates jobs and dispatch state before triggering", async () => {
  let createdData: Record<string, unknown> | null = null;
  const dispatchUpdatedAt = new Date("2026-08-04T18:00:00.000Z");
  const tx = {
    professionalContactRequest: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return {
          id: "request-1",
          dispatch: {
            status: "pending",
            attemptCount: 0,
            updatedAt: dispatchUpdatedAt,
          },
        };
      },
    },
    professionalContactEvent: { create: async () => ({}) },
  };
  const result = await createProfessionalContactRequest(
    {
      organizationName: "LED Presents",
      website: "https://ledpresents.com/",
      locationContext: "San Diego",
      notes: "Founders",
      personNames: "Jane Doe\nJohn Smith",
    },
    transactionRunner(tx),
  );
  assert.equal(result.requestId, "request-1");
  assert.equal(result.jobCount, 2);
  assert.equal(result.dispatchStatus, "pending");
  assert.deepEqual(
    (createdData as { dispatch?: unknown } | null)?.dispatch,
    { create: {} },
  );
  assert.equal(
    (
      createdData as {
        jobs?: { create?: unknown[] };
      } | null
    )?.jobs?.create?.length,
    2,
  );
});

test("professional contact submission rejects personal, generic, duplicate, and weak candidates", () => {
  assert.throws(
    () =>
      parseProfessionalContactSubmission({
        ...validSubmission,
        candidates: [{ ...validCandidate, email: "jane.doe@gmail.com" }],
      }),
    /public or disposable email provider/,
  );
  assert.throws(
    () =>
      parseProfessionalContactSubmission({
        ...validSubmission,
        candidates: [
          { ...validCandidate, email: "info@ledpresents.com" },
        ],
      }),
    /generic or role inbox/,
  );
  assert.throws(
    () =>
      parseProfessionalContactSubmission({
        ...validSubmission,
        candidates: [validCandidate, validCandidate],
      }),
    /duplicate email/,
  );
  assert.throws(
    () =>
      parseProfessionalContactSubmission({
        ...validSubmission,
        candidates: [{ ...validCandidate, evidence: "Looks plausible." }],
      }),
    /substantively include/,
  );
});

test("domain pattern inference is explicit and low confidence", () => {
  assert.throws(
    () =>
      parseProfessionalContactSubmission({
        ...validSubmission,
        candidates: [
          {
            ...validCandidate,
            confidence: "medium",
            discoveryMethod: "domain_pattern",
            patternEvidence:
              "Published staff addresses establish firstname.lastname at the organization domain.",
            patternEvidenceUrl:
              "https://ledpresents.com/team/email-pattern",
            sourceUrls: [
              "https://ledpresents.com/team/jane-doe",
              "https://ledpresents.com/team/email-pattern",
            ],
            patternExamples: [
              {
                email: "alex.lee@ledpresents.com",
                personName: "Alex Lee",
              },
              {
                email: "maria.garcia@ledpresents.com",
                personName: "Maria Garcia",
              },
            ],
          },
        ],
      }),
    /requires low confidence/,
  );
});

test("claim limits and OIDC claims fail closed", async () => {
  assert.equal(parseProfessionalContactClaimLimit(undefined), 1);
  assert.throws(() => parseProfessionalContactClaimLimit(11), /1 to 10/);
  const claims = {
    aud: PROFESSIONAL_CONTACT_OIDC_AUDIENCE,
    repository: "zspherez/photo-admin",
    repository_owner: "zspherez",
    ref: "refs/heads/main",
    workflow_ref: PROFESSIONAL_CONTACT_WORKFLOW_REF,
    event_name: "schedule",
  };
  assert.equal(isTrustedProfessionalContactOidcClaims(claims), true);
  assert.equal(
    isTrustedProfessionalContactOidcClaims({
      ...claims,
      workflow_ref:
        "zspherez/photo-admin/.github/workflows/other.yml@refs/heads/main",
    }),
    false,
  );
  assert.equal(
    await isValidProfessionalContactAuthorization(
      "Bearer local-secret",
      {
        environment: { NODE_ENV: "production" },
        staticToken: "local-secret",
        verifyGithubActionsToken: async () => false,
      },
    ),
    false,
  );
  assert.equal(
    await isValidProfessionalContactAuthorization(
      "Bearer local-secret",
      {
        environment: { NODE_ENV: "development" },
        staticToken: "local-secret",
        verifyGithubActionsToken: async () => false,
      },
    ),
    true,
  );
});

test("queue claims use a lease, increment attempts, and snapshot only request scope", async () => {
  const updates: unknown[] = [];
  const events: unknown[] = [];
  const tx = {
    $queryRaw: async () => [{ id: "job-1" }],
    professionalContactJob: {
      update: async ({ data }: { data: unknown }) => {
        updates.push(data);
        return {};
      },
      findMany: async (args: {
        select: { candidates: { take: number } };
      }) => {
        assert.equal(args.select.candidates.take, 20);
        return [{
          id: "job-1",
          requestId: "request-1",
          personName: "Jane Doe",
          attemptCount: 2,
          request: {
            organizationName: "LED Presents",
            website: "https://ledpresents.com/",
            locationContext: "San Diego",
            notes: "Founders",
            personNames: ["Jane Doe"],
          },
          candidates: [
            {
              id: "candidate-rejected",
              email: "jane.doe@ledpresents.com",
              decision: { action: "rejected" },
            },
          ],
        }];
      },
    },
    professionalContactEvent: {
      create: async ({ data }: { data: unknown }) => {
        events.push(data);
        return {};
      },
    },
  };
  const now = new Date("2026-08-04T18:00:00.000Z");
  const [claim] = await claimProfessionalContactJobs(
    1,
    now,
    transactionRunner(tx),
  );
  assert.equal(claim.jobId, "job-1");
  assert.equal(claim.personName, "Jane Doe");
  assert.equal(claim.attemptCount, 2);
  assert.equal(claim.claimExpiresAt.toISOString(), "2026-08-04T19:00:00.000Z");
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/);
  assert.match(claim.provenanceToken, /^[0-9a-f-]{36}$/);
  assert.notEqual(claim.provenanceToken, claim.claimToken);
  assert.equal(claim.policy.noAutomaticOutreach, true);
  assert.deepEqual(claim.priorCandidates, [
    {
      candidateId: "candidate-rejected",
      email: "jane.doe@ledpresents.com",
      reviewedState: "rejected",
    },
  ]);
  assert.equal(updates.length, 1);
  assert.equal(events.length, 1);
});

test("result submission requires the current lease and is idempotent", async () => {
  const now = new Date("2026-08-04T18:00:00.000Z");
  const state = {
    status: "claimed" as string,
    claimToken: validSubmission.claimToken as string,
    claimProvenanceToken,
    claimExpiresAt: new Date("2026-08-04T19:00:00.000Z"),
    resultFingerprint: null as string | null,
  };
  let createdCandidates = 0;
  let createdRows: unknown[] = [];
  const tx = {
    professionalContactJob: {
      findUnique: async () => ({
        id: "job-1",
        requestId: "request-1",
        personName: "Jane Doe",
        ...state,
        request: {
          organizationName: "LED Presents",
          website: "https://ledpresents.com/",
        },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state, data);
        return {};
      },
    },
    professionalContactCandidate: {
      findMany: async () => [],
      createMany: async ({ data }: { data: unknown[] }) => {
        createdCandidates += data.length;
        createdRows = data;
        return { count: data.length };
      },
    },
    professionalContactEvent: {
      create: async () => ({}),
    },
  };
  const first = await submitProfessionalContactResult(
    "job-1",
    validSubmission,
    now,
    transactionRunner(tx),
  );
  assert.deepEqual(first, {
    accepted: true,
    status: "review",
    idempotent: false,
  });
  assert.equal(createdCandidates, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(createdRows[0] ?? {}, "provenance"),
    false,
  );
  const repeated = await submitProfessionalContactResult(
    "job-1",
    validSubmission,
    now,
    transactionRunner(tx),
  );
  assert.deepEqual(repeated, {
    accepted: true,
    status: "review",
    idempotent: true,
  });
  assert.equal(createdCandidates, 1);

  state.status = "claimed";
  state.claimToken = "22222222-2222-4222-8222-222222222222";
  state.claimExpiresAt = new Date("2026-08-04T17:00:00.000Z");
  state.resultFingerprint = null;
  const stale = await submitProfessionalContactResult(
    "job-1",
    {
      ...validSubmission,
      claimToken: state.claimToken,
    },
    now,
    transactionRunner(tx),
  );
  assert.equal(stale.accepted, false);
  assert.equal(stale.status, "conflict");

  state.claimToken = "33333333-3333-4333-8333-333333333333";
  state.claimExpiresAt = new Date("2026-08-04T20:00:00.000Z");
  const oldWorker = await submitProfessionalContactResult(
    "job-1",
    {
      ...validSubmission,
      claimToken: "22222222-2222-4222-8222-222222222222",
      provenance: { fabricated: true },
    },
    now,
    transactionRunner(tx),
  );
  assert.deepEqual(oldWorker, {
    accepted: false,
    status: "conflict",
    idempotent: false,
  });
});

test("duplicate-only result keeps the claim active for revised or exhausted submission", async () => {
  const now = new Date("2026-08-04T18:00:00.000Z");
  const state = {
    status: "claimed" as string,
    claimToken: validSubmission.claimToken,
    claimProvenanceToken,
    claimExpiresAt: new Date("2026-08-04T19:00:00.000Z"),
    resultFingerprint: null as string | null,
  };
  let jobUpdates = 0;
  const tx = {
    professionalContactJob: {
      findUnique: async () => ({
        id: "job-1",
        requestId: "request-1",
        personName: "Jane Doe",
        attemptCount: 2,
        ...state,
        request: {
          organizationName: "LED Presents",
          website: "https://ledpresents.com/",
        },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        jobUpdates += 1;
        Object.assign(state, data);
        return {};
      },
    },
    professionalContactCandidate: {
      findMany: async () => [
        { normalizedEmail: "jane.doe@ledpresents.com" },
      ],
    },
    professionalContactEvent: { create: async () => ({}) },
  };
  const duplicate = await submitProfessionalContactResult(
    "job-1",
    validSubmission,
    now,
    transactionRunner(tx),
  );
  assert.deepEqual(duplicate, {
    accepted: false,
    status: "duplicate_candidates",
    idempotent: false,
  });
  assert.equal(state.status, "claimed");
  assert.equal(jobUpdates, 0);

  const exhausted = await submitProfessionalContactResult(
    "job-1",
    {
      outcome: "exhausted",
      claimToken: validSubmission.claimToken,
      notes:
        "The official team and contact pages were checked; the only supported named address was already recorded and rejected.",
      candidates: [],
      provenance: validProvenance,
    },
    now,
    transactionRunner(tx),
  );
  assert.equal(exhausted.accepted, true);
  assert.equal(exhausted.status, "exhausted");
  assert.equal(state.status, "exhausted");
  assert.equal(jobUpdates, 1);
});

test("requeue preserves rejected candidates for the next bounded claim", async () => {
  const updates: Record<string, unknown>[] = [];
  const tx = {
    professionalContactJob: {
      findUnique: async () => ({
        id: "job-1",
        requestId: "request-1",
        status: "completed",
        agentNotes: "Prior attempt",
        candidates: [
          { decision: { action: "rejected" } },
        ],
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    professionalContactEvent: { create: async () => ({}) },
  };
  assert.equal(
    await requeueProfessionalContactJob("job-1", transactionRunner(tx)),
    true,
  );
  assert.equal(updates[0]?.status, "pending");
  assert.equal(
    Object.prototype.hasOwnProperty.call(updates[0] ?? {}, "candidates"),
    false,
  );
});

test("human decisions are immutable and repeated same decisions are idempotent", async () => {
  let decision: { action: string } | null = null;
  let completed = false;
  const tx = {
    professionalContactCandidate: {
      findUnique: async () => ({
        id: "candidate-1",
        jobId: "job-1",
        decision,
        job: { requestId: "request-1", status: "review" },
      }),
      count: async () => 0,
    },
    professionalContactDecision: {
      create: async ({ data }: { data: { action: string } }) => {
        decision = { action: data.action };
        return {};
      },
    },
    professionalContactEvent: { create: async () => ({}) },
    professionalContactJob: {
      update: async () => {
        completed = true;
        return {};
      },
    },
  };
  assert.deepEqual(
    await decideProfessionalContactCandidate(
      "candidate-1",
      "approved",
      new Date(),
      transactionRunner(tx),
    ),
    { ok: true, idempotent: false },
  );
  assert.equal(completed, true);
  assert.deepEqual(
    await decideProfessionalContactCandidate(
      "candidate-1",
      "approved",
      new Date(),
      transactionRunner(tx),
    ),
    { ok: true, idempotent: true },
  );
  assert.match(
    (
      await decideProfessionalContactCandidate(
        "candidate-1",
        "rejected",
        new Date(),
        transactionRunner(tx),
      )
    ).error ?? "",
    /immutable/,
  );
});

function createDispatchHarness() {
  const state = {
    id: "dispatch-1",
    requestId: "request-1",
    status: "pending",
    attemptCount: 0,
    leaseToken: null as string | null,
    leaseExpiresAt: null as Date | null,
    lastError: null as string | null,
    updatedAt: new Date("2026-08-04T18:00:00.000Z"),
  };
  const attempts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let updateTick = 0;
  const tx = {
    professionalContactDispatch: {
      findUnique: async () => ({
        ...state,
        request: {
          jobs: [{ status: "pending", claimExpiresAt: null }],
        },
      }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { updatedAt: Date };
        data: Record<string, unknown>;
      }) => {
        if (where.updatedAt.getTime() !== state.updatedAt.getTime()) {
          return { count: 0 };
        }
        state.status = String(data.status);
        state.attemptCount += 1;
        state.leaseToken = String(data.leaseToken);
        state.leaseExpiresAt = data.leaseExpiresAt as Date;
        state.lastError = null;
        updateTick += 1;
        state.updatedAt = new Date(
          Date.parse("2026-08-04T18:00:00.000Z") + updateTick,
        );
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.status = String(data.status);
        state.leaseToken = null;
        state.leaseExpiresAt = null;
        state.lastError =
          typeof data.lastError === "string" ? data.lastError : null;
        updateTick += 1;
        state.updatedAt = new Date(
          Date.parse("2026-08-04T18:00:00.000Z") + updateTick,
        );
        return { updatedAt: state.updatedAt };
      },
    },
    professionalContactDispatchAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push({ ...data });
        return {};
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(attempts.at(-1)!, data);
        return {};
      },
    },
    professionalContactEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ ...data });
        return {};
      },
    },
  };
  return { state, attempts, events, runner: transactionRunner(tx) };
}

test("form dispatch immediately triggers the trusted workflow once", async () => {
  const harness = createDispatchHarness();
  let fetchCalls = 0;
  const result = await dispatchProfessionalContactRequest("request-1", {
    now: new Date("2026-08-04T18:00:00.000Z"),
    token: "dispatch-token",
    fetchImpl: async (url, init) => {
      fetchCalls += 1;
      assert.match(String(url), /professional-contact-research\.yml\/dispatches$/);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ref: "main",
        inputs: { request_id: "request-1" },
      });
      return new Response(null, { status: 204 });
    },
    runTransaction: harness.runner,
  });
  assert.equal(fetchCalls, 1);
  assert.equal(result.state, "dispatched");
  assert.equal(result.triggered, true);
  assert.equal(harness.state.attemptCount, 1);
  assert.equal(harness.attempts[0].status, "succeeded");
  assert.deepEqual(
    harness.events.map((event) => event.kind),
    ["dispatch_started", "dispatch_succeeded"],
  );

  const duplicate = await dispatchProfessionalContactRequest("request-1", {
    token: "dispatch-token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
    runTransaction: harness.runner,
  });
  assert.equal(duplicate.state, "already_dispatched");
  assert.equal(duplicate.triggered, false);
  assert.equal(fetchCalls, 1);
});

test("workflow dispatch accepts GitHub success responses with run metadata", async () => {
  const harness = createDispatchHarness();
  const result = await dispatchProfessionalContactRequest("request-1", {
    now: new Date("2026-08-04T18:00:00.000Z"),
    token: "dispatch-token",
    fetchImpl: async () =>
      Response.json(
        {
          workflow_run_id: 31021072991,
          run_url:
            "https://api.github.com/repos/zspherez/photo-admin/actions/runs/31021072991",
          html_url:
            "https://github.com/zspherez/photo-admin/actions/runs/31021072991",
        },
        { status: 200 },
      ),
    runTransaction: harness.runner,
  });

  assert.equal(result.state, "dispatched");
  assert.equal(result.triggered, true);
  assert.equal(result.error, null);
  assert.equal(harness.state.status, "dispatched");
  assert.equal(harness.attempts[0].status, "succeeded");
  assert.deepEqual(
    harness.events.map((event) => event.kind),
    ["dispatch_started", "dispatch_succeeded"],
  );
});

test("configured trusted workflow override controls the dispatched filename", async () => {
  const harness = createDispatchHarness();
  let dispatchedUrl = "";
  const result = await dispatchProfessionalContactRequest("request-1", {
    now: new Date("2026-08-04T18:00:00.000Z"),
    token: "dispatch-token",
    trustConfig: {
      repository: "zspherez/photo-admin",
      owner: "zspherez",
      workflowRef:
        "zspherez/photo-admin/.github/workflows/custom-professional-worker.yaml@refs/heads/main",
    },
    fetchImpl: async (url, init) => {
      dispatchedUrl = String(url);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        ref: "main",
        inputs: { request_id: "request-1" },
      });
      return new Response(null, { status: 204 });
    },
    runTransaction: harness.runner,
  });
  assert.equal(result.state, "dispatched");
  assert.match(
    dispatchedUrl,
    /actions\/workflows\/custom-professional-worker\.yaml\/dispatches$/,
  );
});

test("dispatch failure preserves queued work and a versioned manual retry triggers again", async () => {
  const harness = createDispatchHarness();
  let fetchCalls = 0;
  const failed = await dispatchProfessionalContactRequest("request-1", {
    now: new Date("2026-08-04T18:00:00.000Z"),
    token: "dispatch-token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json(
        { message: "workflow dispatch denied" },
        { status: 403 },
      );
    },
    runTransaction: harness.runner,
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.triggered, true);
  assert.match(failed.error ?? "", /403.*denied/);
  assert.equal(harness.state.status, "failed");
  assert.equal(harness.state.attemptCount, 1);

  const retryVersion = harness.state.updatedAt;
  const retried = await dispatchProfessionalContactRequest("request-1", {
    mode: "retry",
    expectedUpdatedAt: retryVersion,
    now: new Date("2026-08-04T18:01:00.000Z"),
    token: "dispatch-token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
    runTransaction: harness.runner,
  });
  assert.equal(retried.state, "dispatched");
  assert.equal(retried.triggered, true);
  assert.equal(fetchCalls, 2);
  assert.equal(harness.state.attemptCount, 2);

  const repeatedRetry = await dispatchProfessionalContactRequest("request-1", {
    mode: "retry",
    expectedUpdatedAt: retryVersion,
    token: "dispatch-token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
    runTransaction: harness.runner,
  });
  assert.equal(repeatedRetry.state, "stale");
  assert.equal(repeatedRetry.triggered, false);
  assert.equal(fetchCalls, 2);
});

test("professional contact service has no Artist Contact mutation path", () => {
  const source = readFileSync(
    new URL("./professionalContactResearch.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:tx|db)\.contact\b/);
  assert.doesNotMatch(source, /\bartistId\b/);
  assert.doesNotMatch(source, /ContactResearchJob/);
});
