import {
  CONTACT_RESEARCH_PROBE_CANDIDATE_IDS,
  CONTACT_RESEARCH_PROBE_JOB_IDS,
  CONTACT_RESEARCH_PROBE_MANIFEST_VERSION,
  type CleanupMode,
  type CleanupStatus,
  type ContactResearchProbeCleanupSummary,
} from "@/lib/contactResearchProbeCleanup";

const CLEANUP_STATUSES: CleanupStatus[] = [
  "pending",
  "review",
  "complete",
  "skipped",
  "inactive",
];

const EXPECTED_STATUS: Record<CleanupMode, CleanupAuditStatus> = {
  "dry-run": "preflight_passed",
  apply: "applied_and_verified",
  verify: "verification_passed",
};

type CleanupAuditStatus =
  | "preflight_passed"
  | "applied_and_verified"
  | "verification_passed";

export interface ContactResearchProbeCleanupAuditSummary {
  schemaVersion: 1;
  manifestVersion: string;
  mode: CleanupMode;
  status: CleanupAuditStatus;
  manifest: {
    jobCount: number;
    candidateCount: number;
  };
  counts: {
    syntheticCandidates: number;
    deletedCandidates: number;
    preservedCandidates: number;
    clearedAgentNotes: number;
    trimmedDrinkurwaterNotes: number;
    preservedAgentNotes: number;
    reconciledJobs: number;
    remainingSyntheticCandidates: number;
    remainingSyntheticAgentNotes: number;
  };
  candidateIds: {
    synthetic: string[];
    deleted: string[];
    preservedSubstantive: string[];
  };
  jobIds: {
    clearAgentNotes: string[];
    trimDrinkurwaterNotes: string[];
    preservedAgentNotes: string[];
    reconciled: Record<CleanupStatus, string[]>;
    remainingSyntheticAgentNotes: string[];
  };
  verification: {
    passed: boolean;
    remainingSyntheticCandidateIds: string[];
  };
}

export class ContactResearchProbeCleanupSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactResearchProbeCleanupSummaryError";
  }
}

export function createContactResearchProbeCleanupAuditSummary(
  summary: ContactResearchProbeCleanupSummary
): ContactResearchProbeCleanupAuditSummary {
  const reconciledJobs = Object.values(summary.reconciled).reduce(
    (total, ids) => total + ids.length,
    0
  );
  return {
    schemaVersion: 1,
    manifestVersion: summary.manifestVersion,
    mode: summary.mode,
    status: EXPECTED_STATUS[summary.mode],
    manifest: { ...summary.manifest },
    counts: {
      syntheticCandidates: summary.candidates.syntheticIds.length,
      deletedCandidates: summary.candidates.deletedIds.length,
      preservedCandidates:
        summary.candidates.preservedSubstantiveIds.length,
      clearedAgentNotes: summary.agentNotes.clearIds.length,
      trimmedDrinkurwaterNotes:
        summary.agentNotes.drinkurwaterTrimIds.length,
      preservedAgentNotes: summary.agentNotes.preservedIds.length,
      reconciledJobs,
      remainingSyntheticCandidates:
        summary.verification.remainingSyntheticCandidateIds.length,
      remainingSyntheticAgentNotes:
        summary.verification.remainingSyntheticAgentNoteIds.length,
    },
    candidateIds: {
      synthetic: [...summary.candidates.syntheticIds],
      deleted: [...summary.candidates.deletedIds],
      preservedSubstantive: [
        ...summary.candidates.preservedSubstantiveIds,
      ],
    },
    jobIds: {
      clearAgentNotes: [...summary.agentNotes.clearIds],
      trimDrinkurwaterNotes: [
        ...summary.agentNotes.drinkurwaterTrimIds,
      ],
      preservedAgentNotes: [...summary.agentNotes.preservedIds],
      reconciled: Object.fromEntries(
        CLEANUP_STATUSES.map((status) => [
          status,
          [...summary.reconciled[status]],
        ])
      ) as Record<CleanupStatus, string[]>,
      remainingSyntheticAgentNotes: [
        ...summary.verification.remainingSyntheticAgentNoteIds,
      ],
    },
    verification: {
      passed: summary.verification.passed,
      remainingSyntheticCandidateIds: [
        ...summary.verification.remainingSyntheticCandidateIds,
      ],
    },
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} must be an object`
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  name: string
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} contains unexpected fields`
    );
  }
}

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} must be an array of IDs`
    );
  }
  if (new Set(value).size !== value.length) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} contains duplicate IDs`
    );
  }
  return value;
}

function expectedNumber(
  value: unknown,
  expected: number,
  name: string
) {
  if (value !== expected) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} must equal ${expected}`
    );
  }
}

function assertKnownIds(
  ids: string[],
  expected: ReadonlySet<string>,
  name: string
) {
  if (ids.some((id) => !expected.has(id))) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} contains IDs outside the committed manifest`
    );
  }
}

function assertDisjoint(groups: string[][], name: string) {
  const all = groups.flat();
  if (new Set(all).size !== all.length) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} ID groups overlap`
    );
  }
}

function assertSameIds(actual: string[], expected: string[], name: string) {
  if (
    actual.length !== expected.length ||
    [...actual].sort().some((id, index) => id !== [...expected].sort()[index])
  ) {
    throw new ContactResearchProbeCleanupSummaryError(
      `${name} IDs do not match`
    );
  }
}

export function validateContactResearchProbeCleanupAuditSummary(
  value: unknown,
  expectedMode: CleanupMode
): ContactResearchProbeCleanupAuditSummary {
  const root = record(value, "summary");
  exactKeys(
    root,
    [
      "schemaVersion",
      "manifestVersion",
      "mode",
      "status",
      "manifest",
      "counts",
      "candidateIds",
      "jobIds",
      "verification",
    ],
    "summary"
  );
  if (
    root.schemaVersion !== 1 ||
    root.manifestVersion !== CONTACT_RESEARCH_PROBE_MANIFEST_VERSION ||
    root.mode !== expectedMode ||
    root.status !== EXPECTED_STATUS[expectedMode]
  ) {
    throw new ContactResearchProbeCleanupSummaryError(
      "Summary identity does not match the committed cleanup mode and manifest"
    );
  }

  const manifest = record(root.manifest, "manifest");
  exactKeys(manifest, ["jobCount", "candidateCount"], "manifest");
  expectedNumber(
    manifest.jobCount,
    CONTACT_RESEARCH_PROBE_JOB_IDS.length,
    "manifest.jobCount"
  );
  expectedNumber(
    manifest.candidateCount,
    CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.length,
    "manifest.candidateCount"
  );

  const counts = record(root.counts, "counts");
  exactKeys(
    counts,
    [
      "syntheticCandidates",
      "deletedCandidates",
      "preservedCandidates",
      "clearedAgentNotes",
      "trimmedDrinkurwaterNotes",
      "preservedAgentNotes",
      "reconciledJobs",
      "remainingSyntheticCandidates",
      "remainingSyntheticAgentNotes",
    ],
    "counts"
  );
  const candidateIds = record(root.candidateIds, "candidateIds");
  exactKeys(
    candidateIds,
    ["synthetic", "deleted", "preservedSubstantive"],
    "candidateIds"
  );
  const synthetic = stringArray(
    candidateIds.synthetic,
    "candidateIds.synthetic"
  );
  const deleted = stringArray(
    candidateIds.deleted,
    "candidateIds.deleted"
  );
  const preservedCandidates = stringArray(
    candidateIds.preservedSubstantive,
    "candidateIds.preservedSubstantive"
  );
  const candidateManifest = new Set<string>(
    CONTACT_RESEARCH_PROBE_CANDIDATE_IDS
  );
  for (const [ids, name] of [
    [synthetic, "candidateIds.synthetic"],
    [deleted, "candidateIds.deleted"],
    [preservedCandidates, "candidateIds.preservedSubstantive"],
  ] as const) {
    assertKnownIds(ids, candidateManifest, name);
  }
  assertDisjoint(
    [synthetic, preservedCandidates],
    "candidate classification"
  );

  const jobIds = record(root.jobIds, "jobIds");
  exactKeys(
    jobIds,
    [
      "clearAgentNotes",
      "trimDrinkurwaterNotes",
      "preservedAgentNotes",
      "reconciled",
      "remainingSyntheticAgentNotes",
    ],
    "jobIds"
  );
  const clearAgentNotes = stringArray(
    jobIds.clearAgentNotes,
    "jobIds.clearAgentNotes"
  );
  const trimDrinkurwaterNotes = stringArray(
    jobIds.trimDrinkurwaterNotes,
    "jobIds.trimDrinkurwaterNotes"
  );
  const preservedAgentNotes = stringArray(
    jobIds.preservedAgentNotes,
    "jobIds.preservedAgentNotes"
  );
  const remainingSyntheticAgentNotes = stringArray(
    jobIds.remainingSyntheticAgentNotes,
    "jobIds.remainingSyntheticAgentNotes"
  );
  const jobManifest = new Set<string>(CONTACT_RESEARCH_PROBE_JOB_IDS);
  for (const [ids, name] of [
    [clearAgentNotes, "jobIds.clearAgentNotes"],
    [trimDrinkurwaterNotes, "jobIds.trimDrinkurwaterNotes"],
    [preservedAgentNotes, "jobIds.preservedAgentNotes"],
    [
      remainingSyntheticAgentNotes,
      "jobIds.remainingSyntheticAgentNotes",
    ],
  ] as const) {
    assertKnownIds(ids, jobManifest, name);
  }
  assertDisjoint(
    [clearAgentNotes, trimDrinkurwaterNotes, preservedAgentNotes],
    "agent-note classification"
  );

  const reconciled = record(jobIds.reconciled, "jobIds.reconciled");
  exactKeys(reconciled, CLEANUP_STATUSES, "jobIds.reconciled");
  const reconciledIds = CLEANUP_STATUSES.flatMap((status) => {
    const ids = stringArray(
      reconciled[status],
      `jobIds.reconciled.${status}`
    );
    assertKnownIds(ids, jobManifest, `jobIds.reconciled.${status}`);
    return ids;
  });
  if (new Set(reconciledIds).size !== reconciledIds.length) {
    throw new ContactResearchProbeCleanupSummaryError(
      "Reconciled job ID groups overlap"
    );
  }

  const verification = record(root.verification, "verification");
  exactKeys(
    verification,
    ["passed", "remainingSyntheticCandidateIds"],
    "verification"
  );
  if (typeof verification.passed !== "boolean") {
    throw new ContactResearchProbeCleanupSummaryError(
      "verification.passed must be boolean"
    );
  }
  const remainingSyntheticCandidates = stringArray(
    verification.remainingSyntheticCandidateIds,
    "verification.remainingSyntheticCandidateIds"
  );
  assertKnownIds(
    remainingSyntheticCandidates,
    candidateManifest,
    "verification.remainingSyntheticCandidateIds"
  );

  const measuredCounts: Record<string, number> = {
    syntheticCandidates: synthetic.length,
    deletedCandidates: deleted.length,
    preservedCandidates: preservedCandidates.length,
    clearedAgentNotes: clearAgentNotes.length,
    trimmedDrinkurwaterNotes: trimDrinkurwaterNotes.length,
    preservedAgentNotes: preservedAgentNotes.length,
    reconciledJobs: reconciledIds.length,
    remainingSyntheticCandidates: remainingSyntheticCandidates.length,
    remainingSyntheticAgentNotes:
      remainingSyntheticAgentNotes.length,
  };
  for (const [name, expected] of Object.entries(measuredCounts)) {
    expectedNumber(counts[name], expected, `counts.${name}`);
  }

  if (expectedMode !== "verify") {
    expectedNumber(
      synthetic.length + preservedCandidates.length,
      CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.length,
      "classified candidate count"
    );
  }
  if (expectedMode === "dry-run") {
    expectedNumber(deleted.length, 0, "dry-run deleted candidate count");
    expectedNumber(reconciledIds.length, 0, "dry-run reconciled job count");
    if (
      verification.passed ||
      remainingSyntheticCandidates.length > 0 ||
      remainingSyntheticAgentNotes.length > 0
    ) {
      throw new ContactResearchProbeCleanupSummaryError(
        "Dry-run summary contains post-apply verification state"
      );
    }
  } else if (expectedMode === "apply") {
    assertSameIds(deleted, synthetic, "Applied candidate deletion");
    assertSameIds(
      reconciledIds,
      [...CONTACT_RESEARCH_PROBE_JOB_IDS],
      "Reconciled job"
    );
    if (
      !verification.passed ||
      remainingSyntheticCandidates.length > 0 ||
      remainingSyntheticAgentNotes.length > 0
    ) {
      throw new ContactResearchProbeCleanupSummaryError(
        "Apply summary did not pass post-verification"
      );
    }
  } else if (
    synthetic.length > 0 ||
    deleted.length > 0 ||
    clearAgentNotes.length > 0 ||
    trimDrinkurwaterNotes.length > 0 ||
    reconciledIds.length > 0 ||
    !verification.passed ||
    remainingSyntheticCandidates.length > 0 ||
    remainingSyntheticAgentNotes.length > 0
  ) {
    throw new ContactResearchProbeCleanupSummaryError(
      "Verification summary contains remaining cleanup work"
    );
  }

  return value as ContactResearchProbeCleanupAuditSummary;
}

export function contactResearchProbeCleanupJobSummary(
  summary: ContactResearchProbeCleanupAuditSummary
) {
  return [
    `### Contact research probe cleanup: ${summary.mode}`,
    "",
    `- Status: \`${summary.status}\``,
    `- Manifest: \`${summary.manifestVersion}\``,
    `- Manifest jobs: ${summary.manifest.jobCount}`,
    `- Manifest candidates: ${summary.manifest.candidateCount}`,
    `- Synthetic candidates: ${summary.counts.syntheticCandidates}`,
    `- Deleted candidates: ${summary.counts.deletedCandidates}`,
    `- Preserved substantive candidates: ${summary.counts.preservedCandidates}`,
    `- Cleared agent notes: ${summary.counts.clearedAgentNotes}`,
    `- Trimmed agent notes: ${summary.counts.trimmedDrinkurwaterNotes}`,
    `- Reconciled jobs: ${summary.counts.reconciledJobs}`,
    `- Post-verification: ${summary.verification.passed ? "passed" : "not run"}`,
    "",
  ].join("\n");
}
