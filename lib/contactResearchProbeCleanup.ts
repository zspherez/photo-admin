import {
  isObviousSyntheticPlaceholder,
} from "@/lib/contactAgentPayloadValidation.mjs";

export const CONTACT_RESEARCH_PROBE_MANIFEST_VERSION =
  "contact-research-probes-run-29799659026-v1";

export const CONTACT_RESEARCH_PROBE_JOB_IDS = [
  "e2895e37-41c4-4725-a1a1-ba8e9e2418e9",
  "cmru1eylh0007la04plbhibjc",
  "cmru1eyls000dla04fpv6tdtz",
  "cmru1eylv000fla04895nylvy",
  "cmru1eyma000nla0436han4ca",
  "cmru1f2ts000fk104maez68j1",
  "cmru1f2tu000hk104cbbomuam",
  "cmru1f2u2000nk104l4rwp0i4",
  "cmru1g2260015k104l51xsetk",
  "cmru1q7iz000vla04we2j04py",
  "cmru1q7j2000xla04mp7si9qr",
  "cmru1q7j4000zla04nx399b5e",
  "cmru1q7jn0017la0402ikf4lh",
  "cmru1q7jr001bla04gkvhjw6n",
  "cmru1q7jz001hla04ejz9s11p",
  "cmru1q7ka001rla04v1yyp1k1",
  "cmru1qad40001i804883e5bgn",
  "cmru1qeho0017k104hwt0d4y0",
  "cmru1qeij001nk104nhyz3lj6",
  "cmru1qeiv001vk104vefjiarz",
  "cmru1qggm0023k104dv9t0blg",
  "cmru1qggs0027k104k8t3ycsb",
  "cmru1qgha002lk1046owjze0l",
  "34fbf34e-e616-4211-a5c0-6da4daf98495",
  "93b6dd1c-8036-43c3-8e34-c66406da6e70",
  "8e643179-7549-46fa-afc4-e85c1a93eca8",
  "8ac07659-181f-4cf9-bbbc-f0e040c2cc7b",
  "4a4b8bc2-9d81-496d-8bad-575bc975cbac",
  "3aa0d21f-c212-40f2-8771-932f8c9a03fb",
  "323e872a-bcf3-41cd-a6f5-1594f33890c6",
  "c5d228fb-e7b0-4f85-b758-b85a1c59a278",
] as const;

export const CONTACT_RESEARCH_PROBE_CANDIDATE_IDS = [
  "cmrs9gx5l001fjz040qc334jn",
  "cmru4g1140013jx04j53lxo5j",
  "cmru4hb8l0029i204q938p2og",
  "cmru4i9lz0035i204qlyvssw3",
  "cmruh4gd7000fl704whh62vwr",
  "cmrugzuay0001l304q1rhalaq",
  "cmruh1pqq000ll3048meqoreh",
] as const;

export const CONTACT_RESEARCH_PROBE_EXPECTED_PATTERNS = {
  exactLeakedEvidence: [
    "test evidence for save",
    "test no official source",
    "test minimal no official source",
  ],
  syntheticPrefixes: [
    "test",
    "dummy",
    "placeholder",
    "example",
    "probe",
    "save test",
  ],
  candidateEvidencePolicy:
    "synthetic prefix or substantive replacement (minimum 40 characters)",
  candidateOwnershipPolicy:
    "candidate must belong to one of the exact manifest jobs",
  agentNotesPolicy:
    "synthetic prefix, legitimate notes, or a DRINKURWATER substantive note with one trailing test/testing sentence",
} as const;

const JOB_IDS = new Set<string>(CONTACT_RESEARCH_PROBE_JOB_IDS);
const CANDIDATE_IDS = new Set<string>(
  CONTACT_RESEARCH_PROBE_CANDIDATE_IDS
);
const MIN_SUBSTANTIVE_EVIDENCE_LENGTH = 40;

export type CleanupMode = "dry-run" | "apply" | "verify";
export type CleanupStatus =
  | "pending"
  | "review"
  | "complete"
  | "skipped"
  | "inactive";

export interface CleanupJobRow {
  id: string;
  artistName: string;
  agentNotes: string | null;
}

export interface CleanupCandidateRow {
  id: string;
  jobId: string;
  evidence: string | null;
}

export interface ContactResearchProbeCleanupStore {
  readJobs(lock: boolean): Promise<CleanupJobRow[]>;
  readManifestCandidates(lock: boolean): Promise<CleanupCandidateRow[]>;
  readCandidatesForManifestJobs(lock: boolean): Promise<CleanupCandidateRow[]>;
  deleteCandidates(ids: string[]): Promise<number>;
  updateAgentNotes(
    id: string,
    expected: string,
    next: string | null
  ): Promise<boolean>;
  reconcileJob(id: string, now: Date): Promise<CleanupStatus>;
}

export interface ContactResearchProbeCleanupSummary {
  manifestVersion: string;
  mode: CleanupMode;
  manifest: {
    jobCount: number;
    candidateCount: number;
  };
  candidates: {
    syntheticIds: string[];
    deletedIds: string[];
    preservedSubstantiveIds: string[];
  };
  agentNotes: {
    clearIds: string[];
    drinkurwaterTrimIds: string[];
    preservedIds: string[];
  };
  reconciled: Record<CleanupStatus, string[]>;
  verification: {
    passed: boolean;
    remainingSyntheticCandidateIds: string[];
    remainingSyntheticAgentNoteIds: string[];
  };
}

export class ContactResearchProbeCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactResearchProbeCleanupError";
  }
}

function normalizeArtistName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isExpectedProbeSyntheticText(value: unknown) {
  if (typeof value !== "string") return false;
  return isObviousSyntheticPlaceholder(value);
}

function isExpectedTrailingTestingSentence(value: string) {
  return (
    isExpectedProbeSyntheticText(value) ||
    /^testing\b/i.test(value.trim())
  );
}

function splitTrailingSyntheticSentence(value: string) {
  const newlineMatch = value.match(/^([\s\S]+)\r?\n+\s*(.+)$/);
  if (
    newlineMatch &&
    isExpectedTrailingTestingSentence(newlineMatch[2]) &&
    newlineMatch[1].trim().length >= MIN_SUBSTANTIVE_EVIDENCE_LENGTH
  ) {
    return newlineMatch[1].trimEnd();
  }
  const sentenceMatch = value.match(/^([\s\S]*[.!?])\s+([^.!?]+[.!?]?)$/);
  if (
    sentenceMatch &&
    isExpectedTrailingTestingSentence(sentenceMatch[2]) &&
    sentenceMatch[1].trim().length >= MIN_SUBSTANTIVE_EVIDENCE_LENGTH
  ) {
    return sentenceMatch[1].trimEnd();
  }
  return null;
}

export function classifyProbeCandidateEvidence(
  evidence: string | null
): "synthetic" | "substantive" | "unexpected" {
  const trimmed = evidence?.trim() ?? "";
  if (isExpectedProbeSyntheticText(trimmed)) return "synthetic";
  if (trimmed.length >= MIN_SUBSTANTIVE_EVIDENCE_LENGTH) {
    return "substantive";
  }
  return "unexpected";
}

export function classifyProbeAgentNotes(
  artistName: string,
  agentNotes: string | null
):
  | { action: "none" | "clear" | "preserve" }
  | { action: "trim-drinkurwater"; next: string } {
  const trimmed = agentNotes?.trim() ?? "";
  if (!trimmed) return { action: "none" };
  if (isExpectedProbeSyntheticText(trimmed)) return { action: "clear" };
  const withoutSyntheticSuffix = splitTrailingSyntheticSentence(trimmed);
  if (withoutSyntheticSuffix) {
    if (normalizeArtistName(artistName) !== "drinkurwater") {
      throw new ContactResearchProbeCleanupError(
        "Unexpected trailing synthetic agent note outside DRINKURWATER"
      );
    }
    return {
      action: "trim-drinkurwater",
      next: withoutSyntheticSuffix,
    };
  }
  return { action: "preserve" };
}

function sorted(values: Iterable<string>) {
  return [...values].sort();
}

function missingIds(expected: Set<string>, actual: Iterable<string>) {
  const seen = new Set(actual);
  return sorted([...expected].filter((id) => !seen.has(id)));
}

function createSummary(mode: CleanupMode): ContactResearchProbeCleanupSummary {
  return {
    manifestVersion: CONTACT_RESEARCH_PROBE_MANIFEST_VERSION,
    mode,
    manifest: {
      jobCount: CONTACT_RESEARCH_PROBE_JOB_IDS.length,
      candidateCount: CONTACT_RESEARCH_PROBE_CANDIDATE_IDS.length,
    },
    candidates: {
      syntheticIds: [],
      deletedIds: [],
      preservedSubstantiveIds: [],
    },
    agentNotes: {
      clearIds: [],
      drinkurwaterTrimIds: [],
      preservedIds: [],
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

async function verifyNoSyntheticMarkers(
  store: ContactResearchProbeCleanupStore,
  summary: ContactResearchProbeCleanupSummary,
  lock: boolean
) {
  const [jobs, candidates] = await Promise.all([
    store.readJobs(lock),
    store.readCandidatesForManifestJobs(lock),
  ]);
  summary.verification.remainingSyntheticCandidateIds = sorted(
    candidates
      .filter(
        (candidate) =>
          classifyProbeCandidateEvidence(candidate.evidence) === "synthetic"
      )
      .map((candidate) => candidate.id)
  );
  summary.verification.remainingSyntheticAgentNoteIds = sorted(
    jobs
      .filter((job) => {
        const classification = classifyProbeAgentNotes(
          job.artistName,
          job.agentNotes
        );
        return (
          classification.action === "clear" ||
          classification.action === "trim-drinkurwater"
        );
      })
      .map((job) => job.id)
  );
  summary.verification.passed =
    summary.verification.remainingSyntheticCandidateIds.length === 0 &&
    summary.verification.remainingSyntheticAgentNoteIds.length === 0;
  if (!summary.verification.passed) {
    throw new ContactResearchProbeCleanupError(
      "Synthetic markers remain in manifest jobs"
    );
  }
}

export async function runContactResearchProbeCleanup(
  store: ContactResearchProbeCleanupStore,
  options: { mode: CleanupMode; now?: Date }
): Promise<ContactResearchProbeCleanupSummary> {
  const { mode } = options;
  const summary = createSummary(mode);
  const lock = mode === "apply";
  const jobs = await store.readJobs(lock);
  const manifestCandidates = await store.readManifestCandidates(lock);
  const allCandidates = await store.readCandidatesForManifestJobs(lock);
  const missingJobs = missingIds(JOB_IDS, jobs.map((job) => job.id));
  if (missingJobs.length > 0) {
    throw new ContactResearchProbeCleanupError(
      `Missing manifest job IDs: ${missingJobs.join(",")}`
    );
  }
  if (mode !== "verify") {
    const missingCandidates = missingIds(
      CANDIDATE_IDS,
      manifestCandidates.map((candidate) => candidate.id)
    );
    if (missingCandidates.length > 0) {
      throw new ContactResearchProbeCleanupError(
        `Missing manifest candidate IDs: ${missingCandidates.join(",")}`
      );
    }
  }
  for (const candidate of manifestCandidates) {
    if (!JOB_IDS.has(candidate.jobId)) {
      throw new ContactResearchProbeCleanupError(
        `Manifest candidate has unexpected job ownership: ${candidate.id}`
      );
    }
    const classification = classifyProbeCandidateEvidence(candidate.evidence);
    if (classification === "unexpected") {
      throw new ContactResearchProbeCleanupError(
        `Manifest candidate evidence is neither synthetic nor substantive: ${candidate.id}`
      );
    }
    if (classification === "synthetic") {
      summary.candidates.syntheticIds.push(candidate.id);
    } else {
      summary.candidates.preservedSubstantiveIds.push(candidate.id);
    }
  }
  const unlistedSyntheticCandidates = allCandidates.filter(
    (candidate) =>
      !CANDIDATE_IDS.has(candidate.id) &&
      classifyProbeCandidateEvidence(candidate.evidence) === "synthetic"
  );
  if (unlistedSyntheticCandidates.length > 0) {
    throw new ContactResearchProbeCleanupError(
      `Unlisted synthetic candidates found: ${sorted(
        unlistedSyntheticCandidates.map((candidate) => candidate.id)
      ).join(",")}`
    );
  }
  const noteChanges: Array<{
    id: string;
    expected: string;
    next: string | null;
  }> = [];
  for (const job of jobs) {
    let classification;
    try {
      classification = classifyProbeAgentNotes(
        job.artistName,
        job.agentNotes
      );
    } catch {
      throw new ContactResearchProbeCleanupError(
        `Unexpected agent note classification: ${job.id}`
      );
    }
    if (classification.action === "clear") {
      summary.agentNotes.clearIds.push(job.id);
      noteChanges.push({
        id: job.id,
        expected: job.agentNotes!,
        next: null,
      });
    } else if (classification.action === "trim-drinkurwater") {
      summary.agentNotes.drinkurwaterTrimIds.push(job.id);
      noteChanges.push({
        id: job.id,
        expected: job.agentNotes!,
        next: classification.next,
      });
    } else if (classification.action === "preserve") {
      summary.agentNotes.preservedIds.push(job.id);
    }
  }
  summary.candidates.syntheticIds.sort();
  summary.candidates.preservedSubstantiveIds.sort();
  summary.agentNotes.clearIds.sort();
  summary.agentNotes.drinkurwaterTrimIds.sort();
  summary.agentNotes.preservedIds.sort();

  if (mode === "verify") {
    await verifyNoSyntheticMarkers(store, summary, false);
    return summary;
  }
  if (mode === "dry-run") {
    return summary;
  }

  if (summary.candidates.syntheticIds.length > 0) {
    const deleted = await store.deleteCandidates(
      summary.candidates.syntheticIds
    );
    if (deleted !== summary.candidates.syntheticIds.length) {
      throw new ContactResearchProbeCleanupError(
        "Candidate delete count did not match the locked manifest"
      );
    }
    summary.candidates.deletedIds = [...summary.candidates.syntheticIds];
  }
  for (const change of noteChanges) {
    const updated = await store.updateAgentNotes(
      change.id,
      change.expected,
      change.next
    );
    if (!updated) {
      throw new ContactResearchProbeCleanupError(
        `Agent note changed after locking: ${change.id}`
      );
    }
  }
  for (const id of CONTACT_RESEARCH_PROBE_JOB_IDS) {
    const status = await store.reconcileJob(
      id,
      options.now ?? new Date()
    );
    summary.reconciled[status].push(id);
  }
  for (const ids of Object.values(summary.reconciled)) ids.sort();
  await verifyNoSyntheticMarkers(store, summary, true);
  return summary;
}
