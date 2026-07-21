import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTACT_RESEARCH_PROBE_CANDIDATE_IDS,
  CONTACT_RESEARCH_PROBE_JOB_IDS,
  CONTACT_RESEARCH_PROBE_MANIFEST_VERSION,
  type ContactResearchProbeCleanupSummary,
} from "@/lib/contactResearchProbeCleanup";
import {
  createContactResearchProbeCleanupAuditSummary,
  validateContactResearchProbeCleanupAuditSummary,
} from "@/lib/contactResearchProbeCleanupSummary";

function dryRunSummary(): ContactResearchProbeCleanupSummary {
  return {
    manifestVersion: CONTACT_RESEARCH_PROBE_MANIFEST_VERSION,
    mode: "dry-run",
    manifest: {
      jobCount: CONTACT_RESEARCH_PROBE_JOB_IDS.length,
      candidateCount: CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.length,
    },
    candidates: {
      syntheticIds: [...CONTACT_RESEARCH_PROBE_CANDIDATE_IDS],
      deletedIds: [],
      preservedSubstantiveIds: [],
    },
    agentNotes: {
      clearIds: [CONTACT_RESEARCH_PROBE_JOB_IDS[0]],
      drinkurwaterTrimIds: [],
      preservedIds: [CONTACT_RESEARCH_PROBE_JOB_IDS[1]],
    },
    reconciled: {
      pending: [],
      review: [],
      complete: [],
      skipped: [],
      inactive: [],
    },
    verification: {
      passed: false,
      remainingSyntheticCandidateIds: [],
      remainingSyntheticAgentNoteIds: [],
    },
  };
}

test("audit summary is an explicit IDs, counts, and status projection", () => {
  const audit = createContactResearchProbeCleanupAuditSummary(
    dryRunSummary()
  );
  validateContactResearchProbeCleanupAuditSummary(audit, "dry-run");
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(
    serialized,
    /"(?:evidence|agentNotes|artistName|DATABASE_URL|DIRECT_URL)"\s*:|postgres(?:ql)?:\/\//i
  );
});

test("summary validation rejects unexpected fields and changed manifest invariants", () => {
  const audit = createContactResearchProbeCleanupAuditSummary(
    dryRunSummary()
  );
  assert.throws(
    () =>
      validateContactResearchProbeCleanupAuditSummary(
        { ...audit, notes: "sensitive" },
        "dry-run"
      ),
    /unexpected fields/
  );
  assert.throws(
    () =>
      validateContactResearchProbeCleanupAuditSummary(
        {
          ...audit,
          manifest: { ...audit.manifest, candidateCount: 999 },
        },
        "dry-run"
      ),
    /candidateCount/
  );
});

test("mode invariants prevent dry-run summaries from claiming apply work", () => {
  const audit = createContactResearchProbeCleanupAuditSummary(
    dryRunSummary()
  );
  assert.throws(
    () =>
      validateContactResearchProbeCleanupAuditSummary(
        {
          ...audit,
          counts: { ...audit.counts, deletedCandidates: 1 },
          candidateIds: {
            ...audit.candidateIds,
            deleted: [CONTACT_RESEARCH_PROBE_CANDIDATE_IDS[0]],
          },
        },
        "dry-run"
      ),
    /dry-run deleted/
  );
  assert.throws(
    () =>
      validateContactResearchProbeCleanupAuditSummary(audit, "apply"),
    /identity/
  );
});

test("apply and verify summaries enforce completed postconditions", () => {
  const applySource = dryRunSummary();
  applySource.mode = "apply";
  applySource.candidates.deletedIds = [
    ...applySource.candidates.syntheticIds,
  ];
  applySource.reconciled.pending = [
    ...CONTACT_RESEARCH_PROBE_JOB_IDS,
  ];
  applySource.verification.passed = true;
  const applyAudit =
    createContactResearchProbeCleanupAuditSummary(applySource);
  validateContactResearchProbeCleanupAuditSummary(applyAudit, "apply");

  const verifySource = dryRunSummary();
  verifySource.mode = "verify";
  verifySource.candidates.syntheticIds = [];
  verifySource.agentNotes.clearIds = [];
  verifySource.verification.passed = true;
  const verifyAudit =
    createContactResearchProbeCleanupAuditSummary(verifySource);
  validateContactResearchProbeCleanupAuditSummary(verifyAudit, "verify");
});
