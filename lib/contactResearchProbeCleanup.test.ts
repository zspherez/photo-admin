import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { contactResearchCleanupStatus } from "@/lib/contactResearch";
import {
  CONTACT_RESEARCH_PROBE_CANDIDATE_IDS,
  CONTACT_RESEARCH_PROBE_JOB_IDS,
  type CleanupCandidateRow,
  type CleanupJobRow,
  type CleanupStatus,
  type ContactResearchProbeCleanupStore,
  classifyProbeAgentNotes,
  classifyProbeCandidateEvidence,
  runContactResearchProbeCleanup,
} from "@/lib/contactResearchProbeCleanup";

interface TestState {
  jobs: CleanupJobRow[];
  candidates: CleanupCandidateRow[];
}

function initialState(): TestState {
  return {
    jobs: CONTACT_RESEARCH_PROBE_JOB_IDS.map((id, index) => ({
      id,
      artistName: index === 0 ? "DRINKURWATER" : `Artist ${index}`,
      agentNotes: null,
    })),
    candidates: CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.map((id, index) => ({
      id,
      jobId:
        CONTACT_RESEARCH_PROBE_JOB_IDS[
          index % CONTACT_RESEARCH_PROBE_JOB_IDS.length
        ],
      evidence: [
        "test evidence for save",
        "test no official source",
        "test minimal no official source",
        "dummy candidate",
        "placeholder candidate",
        "probe save",
        "save test candidate",
      ][index],
    })),
  };
}

function cloneState(state: TestState): TestState {
  return structuredClone(state);
}

function testStore(
  state: TestState,
  options: {
    failReconciliationId?: string;
    statuses?: Partial<Record<string, CleanupStatus>>;
  } = {}
): ContactResearchProbeCleanupStore {
  return {
    async readJobs() {
      return cloneState(state).jobs;
    },
    async readManifestCandidates() {
      return cloneState(state).candidates.filter((candidate) =>
        CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.includes(
          candidate.id as (typeof CONTACT_RESEARCH_PROBE_CANDIDATE_IDS)[number]
        )
      );
    },
    async readCandidatesForManifestJobs() {
      return cloneState(state).candidates.filter((candidate) =>
        CONTACT_RESEARCH_PROBE_JOB_IDS.includes(
          candidate.jobId as (typeof CONTACT_RESEARCH_PROBE_JOB_IDS)[number]
        )
      );
    },
    async deleteCandidates(ids) {
      const before = state.candidates.length;
      state.candidates = state.candidates.filter(
        (candidate) => !ids.includes(candidate.id)
      );
      return before - state.candidates.length;
    },
    async updateAgentNotes(id, expected, next) {
      const job = state.jobs.find((candidate) => candidate.id === id);
      if (!job || job.agentNotes !== expected) return false;
      job.agentNotes = next;
      return true;
    },
    async reconcileJob(id) {
      if (id === options.failReconciliationId) {
        throw new Error("simulated reconciliation failure");
      }
      return options.statuses?.[id] ?? "pending";
    },
  };
}

test("probe cleanup manifest contains exactly the confirmed unique IDs", () => {
  assert.equal(CONTACT_RESEARCH_PROBE_JOB_IDS.length, 31);
  assert.equal(new Set(CONTACT_RESEARCH_PROBE_JOB_IDS).size, 31);
  assert.equal(CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.length, 7);
  assert.equal(new Set(CONTACT_RESEARCH_PROBE_CANDIDATE_IDS).size, 7);
});

test("classifies the exact leaked payloads without rejecting real DRINKURWATER evidence", () => {
  for (const evidence of [
    "test evidence for save",
    "test no official source",
    "test minimal no official source",
  ]) {
    assert.equal(classifyProbeCandidateEvidence(evidence), "synthetic");
  }
  assert.equal(
    classifyProbeCandidateEvidence(
      "DRINKURWATER's official management page identifies manager Alex Doe and provides direct contact context."
    ),
    "substantive"
  );
  assert.equal(
    classifyProbeCandidateEvidence(
      "Test event organizer Jane Doe directly confirmed she manages DRINKURWATER and supplied the booking route."
    ),
    "substantive"
  );
});

test("strips only DRINKURWATER's trailing testing sentence", () => {
  const substantive =
    "Official management and direct-outreach evidence identifies the submitted manager and preserves the real research.";
  assert.deepEqual(
    classifyProbeAgentNotes(
      "DRINKURWATER",
      `${substantive} Test submission persistence only.`
    ),
    { action: "trim-drinkurwater", next: substantive }
  );
  assert.throws(
    () =>
      classifyProbeAgentNotes(
        "Another Artist",
        `${substantive} Test submission persistence only.`
      ),
    /Unexpected trailing synthetic/
  );
});

test("preserves a manifest candidate whose evidence was replaced substantively", async () => {
  const state = initialState();
  state.candidates[0].evidence =
    "The official artist management page names Jordan Manager and confirms the submitted representation relationship.";
  const summary = await runContactResearchProbeCleanup(testStore(state), {
    mode: "dry-run",
  });
  assert.deepEqual(summary.candidates.preservedSubstantiveIds, [
    CONTACT_RESEARCH_PROBE_CANDIDATE_IDS[0],
  ]);
  assert.equal(summary.candidates.syntheticIds.length, 6);
  assert.equal(state.candidates.length, 7);
});

test("aborts on candidate ownership or ambiguous evidence precondition changes", async () => {
  const ownership = initialState();
  ownership.candidates[0].jobId = "unrelated-job";
  await assert.rejects(
    runContactResearchProbeCleanup(testStore(ownership), {
      mode: "dry-run",
    }),
    /unexpected job ownership/
  );

  const ambiguous = initialState();
  ambiguous.candidates[0].evidence = "short unknown value";
  await assert.rejects(
    runContactResearchProbeCleanup(testStore(ambiguous), {
      mode: "dry-run",
    }),
    /neither synthetic nor substantive/
  );
});

test("apply rolls back all candidate and note changes on reconciliation failure", async () => {
  const committed = initialState();
  committed.jobs[0].agentNotes = "test no official source";
  const before = cloneState(committed);
  await assert.rejects(
    (async () => {
      const working = cloneState(committed);
      await runContactResearchProbeCleanup(
        testStore(working, {
          failReconciliationId: CONTACT_RESEARCH_PROBE_JOB_IDS[1],
        }),
        { mode: "apply" }
      );
      committed.jobs = working.jobs;
      committed.candidates = working.candidates;
    })(),
    /simulated reconciliation failure/
  );
  assert.deepEqual(committed, before);
});

test("apply deletes only synthetic manifest candidates and reconciles all jobs", async () => {
  const state = initialState();
  state.candidates[0].evidence =
    "The artist's official representation page names Pat Manager and confirms the submitted management relationship.";
  state.jobs[0].agentNotes =
    "Official sources and direct outreach identify the artist's actual management relationship. Testing save persistence.";
  state.jobs[1].agentNotes = "test no official source";
  const statuses: Partial<Record<string, CleanupStatus>> = {
    [CONTACT_RESEARCH_PROBE_JOB_IDS[0]]: "review",
    [CONTACT_RESEARCH_PROBE_JOB_IDS[1]]: "complete",
    [CONTACT_RESEARCH_PROBE_JOB_IDS[2]]: "skipped",
    [CONTACT_RESEARCH_PROBE_JOB_IDS[3]]: "inactive",
  };
  const summary = await runContactResearchProbeCleanup(
    testStore(state, { statuses }),
    { mode: "apply", now: new Date("2025-01-01T00:00:00Z") }
  );
  assert.equal(summary.candidates.deletedIds.length, 6);
  assert.equal(state.candidates.length, 1);
  assert.equal(
    state.candidates[0].id,
    CONTACT_RESEARCH_PROBE_CANDIDATE_IDS[0]
  );
  assert.equal(state.jobs[1].agentNotes, null);
  assert.equal(
    state.jobs[0].agentNotes,
    "Official sources and direct outreach identify the artist's actual management relationship."
  );
  assert.equal(summary.verification.passed, true);
  assert.equal(
    Object.values(summary.reconciled).flat().length,
    CONTACT_RESEARCH_PROBE_JOB_IDS.length
  );
});

test("cleanup status reconciliation covers current contacts, skips, review, eligibility, and inactivity", () => {
  const base = {
    hasActiveSkip: false,
    hasPendingCandidate: false,
    hasPendingDirectOutreach: false,
    hasDirectOutreachHistory: false,
    hasActiveEmailContact: false,
    hasEffectiveApproval: false,
    eligible: false,
  };
  assert.equal(
    contactResearchCleanupStatus({ ...base, hasActiveSkip: true }),
    "skipped"
  );
  assert.equal(
    contactResearchCleanupStatus({ ...base, hasPendingCandidate: true }),
    "review"
  );
  assert.equal(
    contactResearchCleanupStatus({ ...base, hasActiveEmailContact: true }),
    "complete"
  );
  assert.equal(
    contactResearchCleanupStatus({
      ...base,
      hasActiveEmailContact: true,
      hasDirectOutreachHistory: true,
    }),
    "complete"
  );
  assert.equal(
    contactResearchCleanupStatus({ ...base, eligible: true }),
    "pending"
  );
  assert.equal(contactResearchCleanupStatus(base), "inactive");
});

test("cleanup CLI is confirmation-gated, Serializable, and does not log evidence", async () => {
  const [source, reconciliationSource] = await Promise.all([
    readFile(
      new URL(
        "../scripts/cleanup-contact-research-probes.ts",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(new URL("./contactResearch.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /CLEANUP_RESEARCH_PROBES/);
  assert.match(
    source,
    /Prisma\.TransactionIsolationLevel\.Serializable/
  );
  assert.match(source, /FOR UPDATE/);
  assert.doesNotMatch(source, /console\.log\(.*evidence/i);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL\)/);
  assert.doesNotMatch(
    source,
    /(?:artist|show|contact|outreach|contactAudit)\.(?:create|update|delete)/
  );
  const reconciliation = reconciliationSource.slice(
    reconciliationSource.indexOf(
      "export async function reconcileContactResearchJobAfterProbeCleanup"
    ),
    reconciliationSource.indexOf(
      "async function retryContactResearchJobsByStatus"
    )
  );
  assert.match(reconciliation, /contactResearchJob\.update/);
  assert.doesNotMatch(
    reconciliation,
    /(?:candidate|artist|show|contact|outreach|contactAudit)\.(?:create|update|delete)/
  );
});
