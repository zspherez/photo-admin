import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { festivalLeadTimeWhere } from "./festivalEligibility";
import {
  type ContactResearchTransactionRunner,
  claimContactResearchJobs,
  contactResearchPriority,
  CONTACT_RESEARCH_OIDC_AUDIENCE,
  CONTACT_RESEARCH_WORKFLOW_REF,
  enqueueFestivalManagerResearch,
  festivalManagerResearchJobDisposition,
  isValidContactResearchAuthorization,
  isManagerContact,
  isTrustedAgentSkipRuleProvenance,
  isTrustedContactResearchOidcClaims,
  needsManagerContactResearch,
  normalizeArtistResearchSkipReason,
  normalizeManagerRole,
  normalizeContactResearchUserNotes,
  normalizeContactResearchDomain,
  normalizeOfficialManagementSource,
  normalizeResearchEmail,
  normalizeResearchSourceUrl,
  parseContactResearchClaimLimit,
  parseKnownContactLookup,
  parseContactResearchSubmission,
  approveContactResearchCandidates,
  approveContactResearchCandidate,
  rankKnownContactEmails,
  rejectContactResearchCandidate,
  isOfficialManagementAutoApprovalEligible,
  isContactResearchApprovalEffective,
  refreshContactResearchQueue,
  retryContactResearchJob,
  skipContactResearchArtist,
  skipContactResearchArtistByArtistId,
  submitContactResearchResult,
  unskipContactResearchArtist,
  unskipContactResearchArtistByArtistId,
  updateContactResearchArtistUserNotes,
} from "./contactResearch";

function runWithTransaction(
  tx: unknown
): ContactResearchTransactionRunner {
  return async (work) => work(tx as Prisma.TransactionClient);
}

interface CandidateResolutionState {
  id: string;
  jobId: string;
  normalizedEmail: string;
  email: string;
  name: string | null;
  role: string;
  sourceUrls: string[];
  evidence: string;
  confidence: string;
  needsApproval: boolean;
  officialSourceType: string | null;
  officialSourceUrl: string | null;
  officialManagementLabel: string | null;
  officialSourceEvidence: string | null;
  status: string;
  reviewedAt: Date | null;
}

function createCandidateResolutionHarness(
  initialCandidates: Array<{
    id: string;
    email: string;
    status?: string;
  }>,
  initialJobStatus: "review" | "claimed" = "review"
) {
  const job = {
    id: "job-1",
    artistId: "artist-1",
    status: initialJobStatus as string,
    completedAt: null as Date | null,
    claimToken: initialJobStatus === "claimed" ? "claim-1" : null,
    claimExpiresAt:
      initialJobStatus === "claimed"
        ? new Date("2026-07-22T00:00:00.000Z")
        : null,
    agentNotes: null as string | null,
  };
  const candidates = new Map<string, CandidateResolutionState>(
    initialCandidates.map((candidate) => [
      candidate.id,
      {
        id: candidate.id,
        jobId: job.id,
        normalizedEmail: candidate.email,
        email: candidate.email,
        name: `Manager ${candidate.id}`,
        role: "management",
        sourceUrls: ["https://soundcloud.com/exampleartist"],
        evidence: "Published management contact.",
        confidence: "high",
        needsApproval: true,
        officialSourceType: null,
        officialSourceUrl: null,
        officialManagementLabel: null,
        officialSourceEvidence: null,
        status: candidate.status ?? "pending",
        reviewedAt: null,
      },
    ])
  );
  const contacts = new Map<
    string,
    {
      id: string;
      email: string;
      name: string | null;
      role: string | null;
      customPrice: string | null;
      state: string;
    }
  >();
  let nextCandidateId = candidates.size + 1;
  let nextContactId = 1;

  function candidateMatches(
    candidate: CandidateResolutionState,
    where: {
      id?: string | { in?: string[] };
      jobId?: string;
      status?: string;
    }
  ) {
    const ids =
      typeof where.id === "string" ? [where.id] : where.id?.in;
    return (
      (!ids || ids.includes(candidate.id)) &&
      (!where.jobId || where.jobId === candidate.jobId) &&
      (!where.status || where.status === candidate.status)
    );
  }

  const tx = {
    contactResearchCandidate: {
      findMany: async (value: unknown) => {
        const input = value as {
          where: {
            id?: { in: string[] };
            jobId?: string;
            status?: string | { in: string[] };
            job?: { id?: { in: string[] } };
          };
        };
        return [...candidates.values()]
          .filter((candidate) => {
            const status = input.where.status;
            return (
              (!input.where.id?.in ||
                input.where.id.in.includes(candidate.id)) &&
              (!input.where.jobId ||
                candidate.jobId === input.where.jobId) &&
              (!input.where.job?.id?.in ||
                input.where.job.id.in.includes(candidate.jobId)) &&
              (!status ||
                (typeof status === "string"
                  ? candidate.status === status
                  : status.in.includes(candidate.status)))
            );
          })
          .map((candidate) => ({
            ...candidate,
            job: {
              id: job.id,
              artistId: job.artistId,
              status: job.status,
              artist: { id: job.artistId, name: "Example Artist" },
            },
          }));
      },
      findFirst: async (value: unknown) => {
        const input = value as {
          where: { id: string; status: string };
        };
        if (job.status !== "review") return null;
        const candidate = candidates.get(input.where.id);
        return candidate?.status === input.where.status
          ? {
              id: candidate.id,
              jobId: candidate.jobId,
              job: { artistId: job.artistId },
            }
          : null;
      },
      findUnique: async (value: unknown) => {
        const input = value as {
          where: {
            jobId_normalizedEmail: {
              jobId: string;
              normalizedEmail: string;
            };
          };
        };
        const key = input.where.jobId_normalizedEmail;
        return (
          [...candidates.values()].find(
            (candidate) =>
              candidate.jobId === key.jobId &&
              candidate.normalizedEmail === key.normalizedEmail
          ) ?? null
        );
      },
      upsert: async (value: unknown) => {
        const input = value as {
          where: {
            jobId_normalizedEmail: {
              jobId: string;
              normalizedEmail: string;
            };
          };
          create: Omit<CandidateResolutionState, "id" | "status" | "reviewedAt">;
          update: Partial<CandidateResolutionState>;
        };
        const key = input.where.jobId_normalizedEmail;
        const existing = [...candidates.values()].find(
          (candidate) =>
            candidate.jobId === key.jobId &&
            candidate.normalizedEmail === key.normalizedEmail
        );
        if (existing) {
          Object.assign(existing, input.update);
          return { ...existing };
        }
        const created: CandidateResolutionState = {
          ...input.create,
          id: `candidate-${nextCandidateId++}`,
          status: "pending",
          reviewedAt: null,
        };
        candidates.set(created.id, created);
        return { ...created };
      },
      updateMany: async (value: unknown) => {
        const input = value as {
          where: {
            id?: string | { in?: string[] };
            jobId?: string;
            status?: string;
          };
          data: Partial<CandidateResolutionState>;
        };
        let count = 0;
        for (const candidate of candidates.values()) {
          if (!candidateMatches(candidate, input.where)) continue;
          Object.assign(candidate, input.data);
          count += 1;
        }
        return { count };
      },
      count: async (value: unknown) => {
        const input = value as {
          where: { jobId: string; status: string };
        };
        return [...candidates.values()].filter(
          (candidate) =>
            candidate.jobId === input.where.jobId &&
            candidate.status === input.where.status
        ).length;
      },
    },
    contactResearchJob: {
      findFirst: async () =>
        job.status === "claimed"
          ? {
              id: job.id,
              artistId: job.artistId,
              artist: { name: "Example Artist" },
              claimedAgentRules: null,
              claimedAgentRulesVersion: null,
            }
          : null,
      update: async (value: unknown) => {
        const input = value as {
          data: {
            status: string;
            completedAt?: Date | null;
            agentNotes?: string | null;
            claimToken?: null;
            claimExpiresAt?: null;
          };
        };
        Object.assign(job, input.data);
        return { ...job };
      },
    },
    contact: {
      findMany: async () =>
        [...contacts.values()]
          .filter((contact) => contact.state === "active")
          .map((contact) => ({
            artistId: job.artistId,
            email: contact.email,
            state: contact.state,
          })),
      findUnique: async (value: unknown) => {
        const input = value as {
          where: {
            artistId_email: { artistId: string; email: string };
          };
        };
        return contacts.get(input.where.artistId_email.email) ?? null;
      },
      update: async (value: unknown) => {
        const input = value as {
          where: { id: string };
          data: Partial<{
            name: string | null;
            role: string | null;
            state: string;
          }>;
        };
        const contact = [...contacts.values()].find(
          (row) => row.id === input.where.id
        )!;
        Object.assign(contact, input.data);
        return { ...contact };
      },
      create: async (value: unknown) => {
        const input = value as {
          data: {
            email: string;
            name: string | null;
            role: string;
            state: string;
          };
        };
        const contact = {
          id: `contact-${nextContactId++}`,
          email: input.data.email,
          name: input.data.name,
          role: input.data.role,
          customPrice: null,
          state: input.data.state,
        };
        contacts.set(contact.email, contact);
        return { ...contact };
      },
    },
  };
  let transactionTail = Promise.resolve();
  const serialRunner: ContactResearchTransactionRunner = async (work) => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(tx as unknown as Prisma.TransactionClient);
    } finally {
      release();
    }
  };
  return { job, candidates, contacts, tx, serialRunner };
}

function officialCandidate(email: string) {
  return {
    email,
    name: "Official Manager",
    role: "management",
    sourceUrls: ["https://soundcloud.com/exampleartist"],
    evidence: "Official profile publishes the address.",
    confidence: "high",
    needsApproval: false,
    officialSource: {
      type: "soundcloud",
      url: "https://soundcloud.com/exampleartist",
      managementLabel: "management",
      evidence: `Official SoundCloud: management ${email}`,
    },
  };
}

function manualCandidate(email: string) {
  return {
    email,
    name: "Possible Manager",
    role: "management",
    sourceUrls: ["https://agency.example/team"],
    evidence: "Agency roster associates this manager with the artist.",
    confidence: "medium",
    needsApproval: true,
  };
}

async function runApprovalRefreshScenario(input: {
  jobStatus: string;
  candidates: Array<{ id: string; email: string; status: string }>;
  contacts: Array<{
    email: string;
    state: "active" | "quarantined";
  }>;
  beforeTransaction?: () => Promise<void>;
}) {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const state = {
    jobStatus: input.jobStatus,
    candidates: input.candidates.map((candidate) => ({ ...candidate })),
    contacts: input.contacts,
  };
  const runTransaction: ContactResearchTransactionRunner = async (work) => {
    await input.beforeTransaction?.();
    return work({
      showArtist: {
        findMany: async () =>
          state.contacts.some((contact) => contact.state === "active")
            ? []
            : [
                {
                  artistId: "artist-1",
                  show: {
                    date: new Date("2026-08-01T00:00:00.000Z"),
                    interestedAt: null,
                  },
                  artist: { popularity: 50, listenSignals: [] },
                },
              ],
      },
      contactResearchCandidate: {
        findMany: async () =>
          state.candidates
            .filter((candidate) => candidate.status === "approved")
            .map((candidate) => ({
              id: candidate.id,
              normalizedEmail: candidate.email,
              jobId: "job-1",
              job: { artistId: "artist-1" },
            })),
        updateMany: async (value: unknown) => {
          const input = value as {
            where: { id: { in: string[] } };
            data: { status: string };
          };
          let count = 0;
          for (const candidate of state.candidates) {
            if (!input.where.id.in.includes(candidate.id)) continue;
            candidate.status = input.data.status;
            count += 1;
          }
          return { count };
        },
      },
      contact: {
        findMany: async () =>
          state.contacts
            .filter((contact) => contact.state === "active")
            .map((contact) => ({
              artistId: "artist-1",
              email: contact.email,
              state: contact.state,
            })),
      },
      contactResearchJob: {
        findMany: async (value: unknown) => {
          const query = value as {
            where?: {
              requestedShow?: unknown;
              artistId?: { in?: string[] };
            };
          };
          if (query.where?.requestedShow) return [];
          return query.where?.artistId?.in?.includes("artist-1")
            ? [
                {
                  id: "job-1",
                  artistId: "artist-1",
                  status: state.jobStatus,
                  candidates: state.candidates
                    .filter(
                      (candidate) => candidate.status === "superseded"
                    )
                    .slice(0, 1)
                    .map((candidate) => ({ id: candidate.id })),
                },
              ]
            : [];
        },
        updateMany: async (value: unknown) => {
          const query = value as {
            where?: { status?: { in?: string[] } };
            data?: { status?: string };
          };
          if (
            query.data?.status === "complete" &&
            query.where?.status?.in?.includes(state.jobStatus) &&
            state.contacts.some((contact) => contact.state === "active")
          ) {
            state.jobStatus = "complete";
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      $executeRaw: async () => {
        const superseded = state.candidates.some(
          (candidate) => candidate.status === "superseded"
        );
        if (
          state.jobStatus === "complete" ||
          state.jobStatus === "inactive" ||
          (state.jobStatus === "exhausted" && superseded)
        ) {
          state.jobStatus = "pending";
        }
        return 1;
      },
    } as unknown as Prisma.TransactionClient);
  };
  const result = await refreshContactResearchQueue(now, runTransaction);
  return { result, state };
}

async function runDirectClaimScenario(input: {
  contactState: "active" | "quarantined";
  beforeTransaction?: () => Promise<void>;
}) {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const state = {
    contactState: input.contactState,
    candidateStatus: "approved",
    jobStatus: "pending",
    attemptCount: 0,
  };
  const claims = await claimContactResearchJobs(
    1,
    now,
    async (work) => {
      await input.beforeTransaction?.();
      state.contactState = input.contactState;
      return work({
        agentRuleSet: { findUnique: async () => null },
        $queryRaw: async () =>
          state.contactState === "active" ? [] : [{ id: "job-1" }],
        contactResearchCandidate: {
          findMany: async () =>
            state.candidateStatus === "approved"
              ? [
                  {
                    id: "candidate-1",
                    normalizedEmail: "manager@example.com",
                    job: { artistId: "artist-1" },
                  },
                ]
              : [],
          updateMany: async (value: unknown) => {
            state.candidateStatus = (
              value as { data: { status: string } }
            ).data.status;
            return { count: 1 };
          },
        },
        contact: {
          findMany: async () =>
            state.contactState === "active"
              ? [
                  {
                    artistId: "artist-1",
                    email: "manager@example.com",
                    state: "active",
                  },
                ]
              : [],
        },
        contactResearchJob: {
          update: async (value: unknown) => {
            const update = value as {
              data: {
                status: string;
                claimToken: string;
                claimExpiresAt: Date;
                attemptCount: { increment: number };
                claimedAgentRules: string;
                claimedAgentRulesVersion: number;
              };
            };
            state.jobStatus = update.data.status;
            state.attemptCount += update.data.attemptCount.increment;
            return {};
          },
          findMany: async () => [
            {
              id: "job-1",
              attemptCount: state.attemptCount,
              priority: 100,
              claimedAgentRules: "",
              claimedAgentRulesVersion: 0,
              userNotes: null,
              artist: {
                id: "artist-1",
                name: "Example Artist",
                spotifyId: null,
                edmtrainId: null,
                genres: null,
                popularity: 50,
                contacts: [],
                shows: [],
              },
            },
          ],
        },
      } as unknown as Prisma.TransactionClient);
    }
  );
  return { claims, state };
}

test("effective approvals require an active same-email artist contact", () => {
  assert.equal(
    isContactResearchApprovalEffective("manager@example.com", [
      { email: "manager@example.com", state: "active" },
    ]),
    true
  );
  assert.equal(
    isContactResearchApprovalEffective("manager@example.com", [
      { email: "MANAGER@example.com", state: "active" },
    ]),
    true,
    "an active replacement row with the same email remains effective"
  );
  assert.equal(
    isContactResearchApprovalEffective("manager@example.com", [
      { email: "manager@example.com", state: "quarantined" },
      { email: "other@example.com", state: "active" },
    ]),
    false
  );
});

test("direct claim supersedes an ineffective approval without refresh", async () => {
  const { claims, state } = await runDirectClaimScenario({
    contactState: "quarantined",
  });

  assert.equal(claims.length, 1);
  assert.equal(state.candidateStatus, "superseded");
  assert.equal(state.jobStatus, "claimed");
});

test("direct claim preserves effective approvals and does not claim", async () => {
  const { claims, state } = await runDirectClaimScenario({
    contactState: "active",
  });

  assert.deepEqual(claims, []);
  assert.equal(state.candidateStatus, "approved");
  assert.equal(state.jobStatus, "pending");
});

test("direct exhausted retry supersedes obsolete approval history", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const state = { candidateStatus: "approved" };
  const retried = await retryContactResearchJob(
    "job-1",
    now,
    runWithTransaction({
      contactResearchCandidate: {
        findMany: async () => [
          {
            id: "candidate-1",
            normalizedEmail: "manager@example.com",
            job: { artistId: "artist-1" },
          },
        ],
        updateMany: async (value: unknown) => {
          state.candidateStatus = (
            value as { data: { status: string } }
          ).data.status;
          return { count: 1 };
        },
      },
      contact: { findMany: async () => [] },
      $executeRaw: async () => {
        assert.equal(state.candidateStatus, "superseded");
        return 1;
      },
    })
  );

  assert.equal(retried, true);
  assert.equal(state.candidateStatus, "superseded");
});

test("claim observes a concurrent audit quarantine atomically", async () => {
  let enterClaim!: () => void;
  let releaseClaim!: () => void;
  const claimEntered = new Promise<void>((resolve) => {
    enterClaim = resolve;
  });
  const claimRelease = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const input: {
    contactState: "active" | "quarantined";
    beforeTransaction: () => Promise<void>;
  } = {
    contactState: "active",
    beforeTransaction: async () => {
      enterClaim();
      await claimRelease;
    },
  };

  const claiming = runDirectClaimScenario(input);
  await claimEntered;
  input.contactState = "quarantined";
  releaseClaim();
  const { claims, state } = await claiming;

  assert.equal(claims.length, 1);
  assert.equal(state.candidateStatus, "superseded");
  assert.equal(state.jobStatus, "claimed");
});

test("active approved contacts suppress queue refresh", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "complete",
    candidates: [
      { id: "approved-1", email: "manager@example.com", status: "approved" },
    ],
    contacts: [{ email: "manager@example.com", state: "active" }],
  });

  assert.equal(result.eligible, 0);
  assert.equal(result.enqueued, 0);
  assert.equal(state.jobStatus, "complete");
  assert.equal(state.candidates[0].status, "approved");
});

test("a replacement active contact with the approved email suppresses refresh", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "complete",
    candidates: [
      { id: "approved-1", email: "manager@example.com", status: "approved" },
    ],
    contacts: [{ email: "MANAGER@example.com", state: "active" }],
  });

  assert.equal(result.eligible, 0);
  assert.equal(state.jobStatus, "complete");
  assert.equal(state.candidates[0].status, "approved");
});

test("one effective approval suppresses refresh when another is obsolete", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "complete",
    candidates: [
      { id: "approved-1", email: "old@example.com", status: "approved" },
      { id: "approved-2", email: "current@example.com", status: "approved" },
    ],
    contacts: [{ email: "current@example.com", state: "active" }],
  });

  assert.equal(result.eligible, 0);
  assert.equal(state.jobStatus, "complete");
  assert.deepEqual(
    state.candidates.map((candidate) => candidate.status),
    ["superseded", "approved"]
  );
});

test("quarantined approvals are superseded and refreshed for new research", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "complete",
    candidates: [
      { id: "approved-1", email: "manager@example.com", status: "approved" },
    ],
    contacts: [{ email: "manager@example.com", state: "quarantined" }],
  });

  assert.equal(result.enqueued, 1);
  assert.equal(state.jobStatus, "pending");
  assert.equal(state.candidates[0].status, "superseded");
  const source = readFileSync(
    new URL("./contactResearch.ts", import.meta.url),
    "utf8"
  );
  const claim = source.slice(
    source.indexOf("export async function claimContactResearchJobs"),
    source.indexOf("export async function submitContactResearchResult")
  );
  assert.match(claim, /JOIN "Contact" approved_contact/);
  assert.match(
    claim,
    /LOWER\(BTRIM\(approved_contact\."email"\)\)[\s\S]*candidate\."normalizedEmail"/
  );
  assert.doesNotMatch(claim, /candidate_history\."status" = 'superseded'/);
});

test("obsolete approval with a pending candidate stays in review", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "review",
    candidates: [
      { id: "approved-1", email: "old@example.com", status: "approved" },
      { id: "pending-1", email: "pending@example.com", status: "pending" },
    ],
    contacts: [{ email: "old@example.com", state: "quarantined" }],
  });

  assert.equal(result.enqueued, 0);
  assert.equal(result.reprioritized, 1);
  assert.equal(state.jobStatus, "review");
  assert.deepEqual(
    state.candidates.map((candidate) => candidate.status),
    ["superseded", "pending"]
  );
});

test("an exhausted job with superseded approval history reopens", async () => {
  const { result, state } = await runApprovalRefreshScenario({
    jobStatus: "exhausted",
    candidates: [
      {
        id: "approved-1",
        email: "old@example.com",
        status: "superseded",
      },
    ],
    contacts: [{ email: "old@example.com", state: "quarantined" }],
  });

  assert.equal(result.enqueued, 1);
  assert.equal(state.jobStatus, "pending");
});

test("approving one candidate leaves every other proposal pending", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);

  const result = await approveContactResearchCandidate(
    "candidate-1",
    now,
    harness.serialRunner,
    async () => ["one@example.com: Sheet unavailable"]
  );

  assert.equal(result.ok, true);
  assert.match(result.sheetError ?? "", /Sheet unavailable/);
  assert.equal(harness.candidates.get("candidate-1")?.status, "approved");
  assert.equal(harness.candidates.get("candidate-2")?.status, "pending");
  assert.equal(harness.job.status, "review");
  assert.equal(harness.job.completedAt, null);
});

test("approving both candidates sequentially completes the job", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);
  const writeSheet = async () => [] as string[];

  assert.equal(
    (
      await approveContactResearchCandidate(
        "candidate-1",
        now,
        harness.serialRunner,
        writeSheet
      )
    ).ok,
    true
  );
  assert.equal(harness.job.status, "review");
  assert.equal(
    (
      await approveContactResearchCandidate(
        "candidate-2",
        now,
        harness.serialRunner,
        writeSheet
      )
    ).ok,
    true
  );
  assert.equal(harness.job.status, "complete");
  assert.equal(harness.job.completedAt, now);
});

test("rejecting the final candidate after an approval completes", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);

  await approveContactResearchCandidate(
    "candidate-1",
    now,
    harness.serialRunner,
    async () => []
  );
  const rejected = await rejectContactResearchCandidate(
    "candidate-2",
    now,
    harness.serialRunner
  );

  assert.deepEqual(rejected, { ok: true, exhausted: false });
  assert.equal(harness.job.status, "complete");
  assert.equal(harness.job.completedAt, now);
});

test("job resolution ignores an approval whose contact was quarantined", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);

  await approveContactResearchCandidate(
    "candidate-1",
    now,
    harness.serialRunner,
    async () => []
  );
  harness.contacts.get("one@example.com")!.state = "quarantined";
  const rejected = await rejectContactResearchCandidate(
    "candidate-2",
    now,
    harness.serialRunner
  );

  assert.deepEqual(rejected, { ok: true, exhausted: true });
  assert.equal(harness.job.status, "exhausted");
  assert.equal(harness.job.completedAt, null);
});

test("rejecting every candidate exhausts the job", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);

  assert.deepEqual(
    await rejectContactResearchCandidate(
      "candidate-1",
      now,
      harness.serialRunner
    ),
    { ok: true, exhausted: false }
  );
  assert.deepEqual(
    await rejectContactResearchCandidate(
      "candidate-2",
      now,
      harness.serialRunner
    ),
    { ok: true, exhausted: true }
  );
  assert.equal(harness.job.status, "exhausted");
  assert.equal(harness.job.completedAt, null);
});

test("concurrent approval and rejection resolve from final candidate state", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
  ]);

  const [approved, rejected] = await Promise.all([
    approveContactResearchCandidate(
      "candidate-1",
      now,
      harness.serialRunner,
      async () => []
    ),
    rejectContactResearchCandidate(
      "candidate-2",
      now,
      harness.serialRunner
    ),
  ]);

  assert.equal(approved.ok, true);
  assert.deepEqual(rejected, { ok: true, exhausted: false });
  assert.equal(harness.job.status, "complete");
  assert.equal(harness.candidates.get("candidate-1")?.status, "approved");
  assert.equal(harness.candidates.get("candidate-2")?.status, "rejected");
});

test("batch approval resolves only the selected subset", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
    { id: "candidate-2", email: "two@example.com" },
    { id: "candidate-3", email: "three@example.com" },
  ]);

  const result = await approveContactResearchCandidates(
    ["candidate-1", "candidate-2"],
    now,
    harness.serialRunner,
    async () => []
  );

  assert.equal(result.ok, true);
  assert.equal(result.approvedCount, 2);
  assert.equal(harness.candidates.get("candidate-1")?.status, "approved");
  assert.equal(harness.candidates.get("candidate-2")?.status, "approved");
  assert.equal(harness.candidates.get("candidate-3")?.status, "pending");
  assert.equal(harness.job.status, "review");
});

test("stale candidate actions fail without changing resolved state", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([
    { id: "candidate-1", email: "one@example.com" },
  ]);
  let sheetWrites = 0;

  await approveContactResearchCandidate(
    "candidate-1",
    now,
    harness.serialRunner,
    async () => {
      sheetWrites += 1;
      return [];
    }
  );
  const stale = await approveContactResearchCandidate(
    "candidate-1",
    now,
    harness.serialRunner,
    async () => {
      sheetWrites += 1;
      return [];
    }
  );

  assert.deepEqual(stale, {
    ok: false,
    error: "Candidate is no longer reviewable",
  });
  assert.equal(sheetWrites, 1);
  assert.equal(harness.job.status, "complete");
});

test("rediscovered obsolete approval returns to manual review", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness(
    [
      {
        id: "candidate-1",
        email: "manager@example.com",
        status: "approved",
      },
    ],
    "claimed"
  );
  harness.contacts.set("manager@example.com", {
    id: "contact-1",
    email: "manager@example.com",
    name: "Old Manager",
    role: "management",
    customPrice: null,
    state: "quarantined",
  });

  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes: "Rediscovered for review.",
      candidates: [manualCandidate("manager@example.com")],
    },
    now,
    harness.serialRunner,
    async () => []
  );

  assert.equal(result.status, "review");
  assert.equal(result.autoApproved, 0);
  assert.equal(harness.candidates.get("candidate-1")?.status, "pending");
  assert.equal(harness.candidates.get("candidate-1")?.reviewedAt, null);
  assert.equal(
    harness.contacts.get("manager@example.com")?.state,
    "quarantined"
  );
});

test("rediscovered official approval reactivates and auto-approves", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness(
    [
      {
        id: "candidate-1",
        email: "manager@example.com",
        status: "approved",
      },
    ],
    "claimed"
  );
  harness.contacts.set("manager@example.com", {
    id: "contact-1",
    email: "manager@example.com",
    name: "Old Manager",
    role: "management",
    customPrice: null,
    state: "quarantined",
  });

  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes: "Official source reconfirmed the contact.",
      candidates: [officialCandidate("manager@example.com")],
    },
    now,
    harness.serialRunner,
    async () => []
  );

  assert.equal(result.status, "complete");
  assert.equal(result.autoApproved, 1);
  assert.equal(harness.candidates.get("candidate-1")?.status, "approved");
  assert.equal(
    harness.contacts.get("manager@example.com")?.state,
    "active"
  );
});

test("submission preserves only an effective existing approval", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const approvedAt = new Date("2026-07-20T12:00:00.000Z");
  const harness = createCandidateResolutionHarness(
    [
      {
        id: "candidate-1",
        email: "manager@example.com",
        status: "approved",
      },
    ],
    "claimed"
  );
  harness.candidates.get("candidate-1")!.reviewedAt = approvedAt;
  harness.contacts.set("manager@example.com", {
    id: "contact-1",
    email: "manager@example.com",
    name: "Current Manager",
    role: "management",
    customPrice: null,
    state: "active",
  });

  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes: "Effective approval repeated.",
      candidates: [officialCandidate("manager@example.com")],
    },
    now,
    harness.serialRunner,
    async () => []
  );

  assert.equal(result.status, "complete");
  assert.equal(result.autoApproved, 0);
  assert.equal(harness.candidates.get("candidate-1")?.status, "approved");
  assert.equal(
    harness.candidates.get("candidate-1")?.reviewedAt,
    approvedAt
  );
});

test("auto-approval leaves manual candidates awaiting review", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([], "claimed");
  let appended = 0;

  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes: "Two possible contacts.",
      candidates: [
        officialCandidate("official@example.com"),
        {
          email: "manual@example.com",
          name: "Possible Manager",
          role: "management",
          sourceUrls: ["https://agency.example/team"],
          evidence: "Agency roster associates this manager with the artist.",
          confidence: "medium",
          needsApproval: true,
        },
      ],
    },
    now,
    harness.serialRunner,
    async (approvals) => {
      appended = approvals.length;
      return [];
    }
  );

  assert.equal(result.status, "review");
  assert.equal(result.autoApproved, 1);
  assert.equal(appended, 1);
  assert.equal(harness.job.status, "review");
  assert.deepEqual(
    [...harness.candidates.values()].map((candidate) => candidate.status).sort(),
    ["approved", "pending"]
  );
});

test("all directly published candidates auto-approve together", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const harness = createCandidateResolutionHarness([], "claimed");

  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      notes: "Official contacts.",
      candidates: [
        officialCandidate("one@example.com"),
        officialCandidate("two@example.com"),
      ],
    },
    now,
    harness.serialRunner,
    async () => []
  );

  assert.equal(result.status, "complete");
  assert.equal(result.autoApproved, 2);
  assert.equal(harness.job.status, "complete");
  assert.equal(harness.job.completedAt, now);
  assert.ok(
    [...harness.candidates.values()].every(
      (candidate) => candidate.status === "approved"
    )
  );
});

test("queue refresh preserves partial review jobs with active contacts", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const updateWheres: unknown[] = [];
  const result = await refreshContactResearchQueue(
    now,
    runWithTransaction({
      showArtist: { findMany: async () => [] },
      contactResearchJob: {
        findMany: async () => [],
        updateMany: async (value: unknown) => {
          updateWheres.push((value as { where: unknown }).where);
          return { count: 0 };
        },
      },
      contactResearchCandidate: { findMany: async () => [] },
    })
  );

  assert.deepEqual(result, {
    eligible: 0,
    enqueued: 0,
    reprioritized: 0,
    completed: 0,
    inactivated: 0,
  });
  assert.equal(updateWheres.length, 2);
  assert.ok(
    updateWheres.every(
      (where) =>
        !JSON.stringify(where).includes('"review"')
    )
  );
});

test("normalizes research emails and rejects malformed values", () => {
  assert.equal(normalizeResearchEmail(" Manager@Example.COM "), "manager@example.com");
  assert.throws(() => normalizeResearchEmail("not-an-email"), /email is invalid/);
  assert.throws(
    () => normalizeResearchEmail("first,second@example.com"),
    /email is invalid/
  );
  assert.throws(
    () => normalizeResearchEmail("manager@example.com full team"),
    /email is invalid/
  );
});

test("treats every active email as an existing manager contact", () => {
  assert.equal(normalizeManagerRole("manager"), "management");
  assert.equal(normalizeManagerRole("management"), "management");
  assert.throws(() => normalizeManagerRole("booking"), /role must be manager/);
  assert.throws(() => normalizeManagerRole("publicist"), /role must be manager/);
  assert.equal(
    isManagerContact({
      email: "manager@example.com",
      role: "Artist Management",
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "booking@example.com",
      role: "booking agent",
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "legacy@example.com",
      role: null,
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "quarantined@example.com",
      role: null,
      state: "quarantined",
    }),
    false
  );
});

test("festival manager research includes unmatched artists without active email contacts", () => {
  const lineup = [
    {
      matched: false,
      popularity: null,
      contacts: [],
    },
    {
      matched: true,
      popularity: 100,
      contacts: [
        {
          email: "booking@example.com",
          role: "legacy booking",
          state: "active" as const,
        },
      ],
    },
  ];

  assert.deepEqual(
    lineup
      .filter((artist) => needsManagerContactResearch(artist.contacts))
      .map((artist) => artist.matched),
    [false]
  );
});

test("festival manager research requests are idempotent across job states", () => {
  assert.equal(festivalManagerResearchJobDisposition(null), "create");
  for (const status of ["pending", "claimed", "review"]) {
    assert.equal(
      festivalManagerResearchJobDisposition(status),
      "existing",
      `${status} jobs must not be duplicated`
    );
  }
  for (const status of ["complete", "exhausted", "inactive"]) {
    assert.equal(
      festivalManagerResearchJobDisposition(status),
      "requeue",
      `${status} jobs should reuse the existing artist job`
    );
  }
});

test("festival enqueue preserves concurrent contact and skip terminal states", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  for (const blocker of ["active contact", "intentional skip"] as const) {
    const state = {
      activeContact: false,
      activeSkip: false,
      jobStatus: "exhausted",
    };
    let eligibilityReads = 0;
    let jobMutations = 0;
    let enterTransaction!: () => void;
    let releaseTransaction!: () => void;
    const transactionEntered = new Promise<void>((resolve) => {
      enterTransaction = resolve;
    });
    const transactionRelease = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const enqueue = enqueueFestivalManagerResearch(
      "show-1",
      now,
      async (work) => {
        enterTransaction();
        await transactionRelease;
        return work({
          show: {
            findFirst: async (value: unknown) => {
              eligibilityReads += 1;
              const input = value as {
                where?: {
                  AND?: unknown[];
                };
                select?: {
                  artists?: {
                    where?: {
                      artist?: {
                        contacts?: unknown;
                        researchSkips?: unknown;
                      };
                    };
                  };
                };
              };
              assert.deepEqual(
                input.select?.artists?.where?.artist?.contacts,
                {
                  none: {
                    state: "active",
                    email: { not: null },
                  },
                }
              );
              assert.deepEqual(
                input.select?.artists?.where?.artist?.researchSkips,
                { none: { clearedAt: null } }
              );
              assert.equal(
                input.where?.AND?.length,
                1,
                "festival enqueue must apply the shared lead-time filter"
              );
              return {
                id: "show-1",
                date: new Date("2026-07-27T00:00:00.000Z"),
                artists:
                  state.activeContact || state.activeSkip
                    ? []
                    : [
                        {
                          artistId: "artist-1",
                          artist: {
                            popularity: 50,
                            listenSignals: [],
                          },
                        },
                      ],
              };
            },
          },
          contactResearchJob: {
            create: async () => {
              jobMutations += 1;
              state.jobStatus = "pending";
              return {};
            },
            update: async () => {
              jobMutations += 1;
              state.jobStatus = "pending";
              return {};
            },
          },
        } as unknown as Prisma.TransactionClient);
      }
    );

    await transactionEntered;
    assert.equal(
      eligibilityReads,
      0,
      `${blocker} eligibility must be read inside the transaction`
    );
    if (blocker === "active contact") {
      state.activeContact = true;
      state.jobStatus = "complete";
    } else {
      state.activeSkip = true;
      state.jobStatus = "skipped";
    }
    releaseTransaction();

    assert.deepEqual(await enqueue, {
      eligible: 0,
      enqueued: 0,
      alreadyQueued: 0,
    });
    assert.equal(jobMutations, 0);
    assert.equal(
      state.jobStatus,
      blocker === "active contact" ? "complete" : "skipped"
    );
  }
});

test("festival enqueue requeues a completed job after approval quarantine", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const state = {
    jobStatus: "complete",
    candidateStatus: "approved",
  };
  const result = await enqueueFestivalManagerResearch(
    "festival-1",
    now,
    runWithTransaction({
      show: {
        findFirst: async () => ({
          id: "festival-1",
          date: new Date("2026-08-01T00:00:00.000Z"),
          artists: [
            {
              artistId: "artist-1",
              artist: { popularity: 50, listenSignals: [] },
            },
          ],
        }),
      },
      contactResearchCandidate: {
        findMany: async () => [
          {
            id: "approved-1",
            normalizedEmail: "manager@example.com",
            jobId: "job-1",
            job: { artistId: "artist-1" },
          },
        ],
        updateMany: async (value: unknown) => {
          state.candidateStatus = (
            value as { data: { status: string } }
          ).data.status;
          return { count: 1 };
        },
      },
      contact: {
        findMany: async () => [],
      },
      contactResearchJob: {
        findMany: async () => [
          {
            id: "job-1",
            artistId: "artist-1",
            status: state.jobStatus,
            candidates: [],
          },
        ],
        update: async (value: unknown) => {
          const input = value as { data: { status?: string } };
          state.jobStatus = input.data.status ?? state.jobStatus;
          return {};
        },
      },
    })
  );

  assert.deepEqual(result, {
    eligible: 1,
    enqueued: 1,
    alreadyQueued: 0,
  });
  assert.equal(state.candidateStatus, "superseded");
  assert.equal(state.jobStatus, "pending");
});

test("refresh reconciles an audit quarantine that wins the serializable race", async () => {
  const contacts: Array<{
    email: string;
    state: "active" | "quarantined";
  }> = [{ email: "manager@example.com", state: "active" }];
  let enterRefresh!: () => void;
  let releaseRefresh!: () => void;
  const refreshEntered = new Promise<void>((resolve) => {
    enterRefresh = resolve;
  });
  const refreshRelease = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const refresh = runApprovalRefreshScenario({
    jobStatus: "exhausted",
    candidates: [
      { id: "approved-1", email: "manager@example.com", status: "approved" },
    ],
    contacts,
    beforeTransaction: async () => {
      enterRefresh();
      await refreshRelease;
    },
  });

  await refreshEntered;
  contacts[0].state = "quarantined";
  releaseRefresh();
  const { result, state } = await refresh;

  assert.equal(result.enqueued, 1);
  assert.equal(state.jobStatus, "pending");
  assert.equal(state.candidates[0].status, "superseded");
});

test("accepts only public HTTP(S) evidence URLs", () => {
  assert.equal(
    normalizeResearchSourceUrl("https://example.com/contact#team"),
    "https://example.com/contact"
  );
  assert.throws(
    () => normalizeResearchSourceUrl("https://user:pass@example.com"),
    /public HTTP\(S\)/
  );
  assert.throws(
    () => normalizeResearchSourceUrl("file:///tmp/contact"),
    /public HTTP\(S\)/
  );
});

test("normalizes bounded owner research notes", () => {
  assert.equal(
    normalizeContactResearchUserNotes("  Skip this artist  "),
    "Skip this artist"
  );
  assert.equal(normalizeContactResearchUserNotes(""), null);
  assert.throws(
    () => normalizeContactResearchUserNotes("x".repeat(4_001)),
    /research notes must be at most 4000 characters/
  );
});

test("requires a human-readable intentional skip reason", () => {
  assert.equal(
    normalizeArtistResearchSkipReason("  Metatone artist  "),
    "Metatone artist"
  );
  assert.throws(
    () => normalizeArtistResearchSkipReason("   "),
    /skip reason is required/
  );
  assert.throws(
    () => normalizeArtistResearchSkipReason("x".repeat(4_001)),
    /skip reason must be at most 4000 characters/
  );
});

test("normalizes known-contact company domains", () => {
  assert.equal(
    normalizeContactResearchDomain("Greg@PalmArtists.com"),
    "palmartists.com"
  );
  assert.equal(
    normalizeContactResearchDomain("https://www.palmartists.com/team"),
    "palmartists.com"
  );
  assert.throws(
    () => normalizeContactResearchDomain("localhost"),
    /company domain is invalid/
  );
});

test("official artist management sources are strictly normalized", () => {
  const official = normalizeOfficialManagementSource(
    {
      type: "instagram",
      url: "https://www.instagram.com/exampleartist/",
      managementLabel: "MGMT",
      evidence: "Official Instagram bio: MGMT manager@example.com",
    },
    "manager@example.com",
    ["https://www.instagram.com/exampleartist/"]
  );
  assert.deepEqual(official, {
    officialSourceType: "instagram",
    officialSourceUrl: "https://www.instagram.com/exampleartist/",
    officialManagementLabel: "mgmt",
    officialSourceEvidence:
      "Official Instagram bio: MGMT manager@example.com",
  });
  assert.equal(
    isOfficialManagementAutoApprovalEligible({
      email: "manager@example.com",
      normalizedEmail: "manager@example.com",
      name: "Manager",
      role: "management",
      sourceUrls: ["https://www.instagram.com/exampleartist/"],
      evidence: "Official Instagram publishes the address.",
      confidence: "high",
      needsApproval: false,
      ...official,
    }),
    true
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "instagram",
          url: "https://example.com/profile",
          managementLabel: "mgmt",
          evidence: "MGMT manager@example.com",
        },
        "manager@example.com",
        ["https://example.com/profile"]
      ),
    /does not match its source type/
  );
  assert.deepEqual(
    normalizeOfficialManagementSource(
      {
        type: "facebook",
        url: "https://facebook.com/exampleartist",
        managementLabel: "mgmt",
        evidence: "Booking manager@example.com",
      },
      "manager@example.com",
      ["https://facebook.com/exampleartist"]
    ),
    {
      officialSourceType: "facebook",
      officialSourceUrl: "https://facebook.com/exampleartist",
      officialManagementLabel: "mgmt",
      officialSourceEvidence: "Booking manager@example.com",
    }
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "website",
          url: "https://exampleartist.com/contact",
          managementLabel: "management",
          evidence: "manager@example.com-management",
        },
        "manager@example.com",
        ["https://exampleartist.com/contact"]
      ),
    /contain the exact candidate email/
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "website",
          url: "https://exampleartist.com/contact",
          managementLabel: "management",
          evidence: "MANAGEMENT !manager@example.com",
        },
        "manager@example.com",
        ["https://exampleartist.com/contact"]
      ),
    /contain the exact candidate email/
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "website",
          url: "https://exampleartist.com/contact",
          managementLabel: "management",
          evidence: "MANAGEMENT booking@manager@example.com",
        },
        "manager@example.com",
        ["https://exampleartist.com/contact"]
      ),
    /contain the exact candidate email/
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "website",
          url: "https://exampleartist.com/contact",
          managementLabel: "management",
          evidence: "manager@example.com_management",
        },
        "manager@example.com",
        ["https://exampleartist.com/contact"]
      ),
    /contain the exact candidate email/
  );
  assert.deepEqual(
    normalizeOfficialManagementSource(
      {
        type: "website",
        url: "https://exampleartist.com/contact",
        managementLabel: "management",
        evidence:
          "MANAGEMENT manager@example.com. Please use this address.",
      },
      "manager@example.com",
      ["https://exampleartist.com/contact"]
    ),
    {
      officialSourceType: "website",
      officialSourceUrl: "https://exampleartist.com/contact",
      officialManagementLabel: "management",
      officialSourceEvidence:
        "MANAGEMENT manager@example.com. Please use this address.",
    }
  );
  assert.throws(
    () =>
      normalizeOfficialManagementSource(
        {
          type: "website",
          url: "https://exampleartist.com/contact",
          managementLabel: "management",
          evidence: "MGMT notmanager@example.com",
        },
        "manager@example.com",
        ["https://exampleartist.com/contact"]
      ),
    /contain the exact candidate email/
  );
  assert.deepEqual(
    normalizeOfficialManagementSource(
      {
        type: "website",
        url: "https://exampleartist.com/contact",
        managementLabel: "management",
        evidence: "management@example.com",
      },
      "management@example.com",
      ["https://exampleartist.com/contact"]
    ),
    {
      officialSourceType: "website",
      officialSourceUrl: "https://exampleartist.com/contact",
      officialManagementLabel: "management",
      officialSourceEvidence: "management@example.com",
    }
  );
  assert.deepEqual(
    normalizeOfficialManagementSource(
      {
        type: "website",
        url: "https://exampleartist.com/contact",
        managementLabel: "management",
        evidence:
          "BOOKING booking@example.com | MANAGEMENT manager@example.com",
      },
      "manager@example.com",
      ["https://exampleartist.com/contact"]
    ),
    {
      officialSourceType: "website",
      officialSourceUrl: "https://exampleartist.com/contact",
      officialManagementLabel: "management",
      officialSourceEvidence:
        "BOOKING booking@example.com | MANAGEMENT manager@example.com",
    }
  );
});

test("official source evidence matches complete Unicode-aware mailbox tokens", () => {
  const normalizeEvidence = (evidence: string) =>
    normalizeOfficialManagementSource(
      {
        type: "website",
        url: "https://exampleartist.com/contact",
        managementLabel: "management",
        evidence,
      },
      "manager@example.com",
      ["https://exampleartist.com/contact"]
    );

  for (const evidence of [
    "émanager@example.com",
    "管理manager@example.com",
    "\u0301manager@example.com",
    "manager@example.comé",
    "manager@example.com管理",
    "manager@example.com\u0301",
    "xmanager@example.com",
    "manager@example.comx",
    "manager@example.com.example",
  ]) {
    assert.throws(
      () => normalizeEvidence(evidence),
      /contain the exact candidate email/,
      evidence
    );
  }

  for (const evidence of [
    "Management: manager@example.com.",
    "Management (manager@example.com),",
    "mailto:manager@example.com",
    '<a href="mailto:manager@example.com?subject=Management">Email</a>',
  ]) {
    assert.equal(
      normalizeEvidence(evidence).officialSourceEvidence,
      evidence
    );
  }
});

test("direct publication is eligible while inferred sources remain review-only", () => {
  const candidate = {
    email: "manager@example.com",
    normalizedEmail: "manager@example.com",
    name: "Manager",
    role: "management" as const,
    sourceUrls: ["https://soundcloud.com/exampleartist"],
    evidence: "Official profile publishes the address.",
    confidence: "high" as const,
    needsApproval: false,
    officialSourceType: "soundcloud" as const,
    officialSourceUrl: "https://soundcloud.com/exampleartist",
    officialManagementLabel: "management" as const,
    officialSourceEvidence:
      "Official SoundCloud: management manager@example.com",
  };
  assert.equal(isOfficialManagementAutoApprovalEligible(candidate), true);
  assert.equal(
    isOfficialManagementAutoApprovalEligible({
      ...candidate,
      officialSourceType: null,
      officialSourceUrl: null,
      officialManagementLabel: null,
      officialSourceEvidence: null,
      needsApproval: true,
    }),
    false
  );
});

test("ranks a matching manager email above a generic company inbox", () => {
  const rows = rankKnownContactEmails(
    [
      {
        email: "info@palmartists.com",
        name: "Palm Artists",
        evidence: "General management inbox.",
        source: "research_candidate",
        status: "pending",
        artists: ["Sonny Fodera"],
        sourceUrls: ["https://palmartists.com"],
      },
      {
        email: "greg@palmartists.com",
        name: null,
        evidence: null,
        source: "active_contact",
        status: "active",
        artists: ["Gorgon City", "SG Lewis"],
        sourceUrls: [],
      },
    ],
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }
  );

  assert.equal(rows[0].email, "greg@palmartists.com");
  assert.ok(rows[0].score > rows[1].score);
  assert.match(
    rows[0].matchReasons.join(" "),
    /local-part matches manager first name/
  );
});

test("known-contact lookups require a meaningful manager or domain", () => {
  assert.deepEqual(
    parseKnownContactLookup({
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }),
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }
  );
  assert.throws(
    () => parseKnownContactLookup({ company: "a" }),
    /manager name or company domain is required/
  );
  assert.throws(
    () => parseKnownContactLookup({ managerName: "G" }),
    /manager name must be at least 2 characters/
  );
});

test("parses and deduplicates evidence-backed candidate submissions", () => {
  const submission = parseContactResearchSubmission({
    outcome: "candidates",
    claimToken: "claim-1",
    notes: "Management preferred.",
    candidates: [
      {
        email: "Manager@Example.com",
        name: "Alex Manager",
        role: "management",
        sourceUrls: [
          "https://artist.example/contact",
          "https://artist.example/contact#team",
        ],
        evidence: "The artist's contact page publishes this management email.",
        confidence: "high",
      },
      {
        email: "manager@example.com",
        role: "manager",
        sourceUrls: ["https://agency.example/team"],
        evidence: "Agency team page confirms the same address.",
        confidence: "medium",
      },
    ],
  });

  assert.equal(submission.outcome, "candidates");
  assert.equal(submission.candidates.length, 1);
  assert.equal(submission.candidates[0].normalizedEmail, "manager@example.com");
  assert.deepEqual(submission.candidates[0].sourceUrls, [
    "https://agency.example/team",
  ]);
  assert.equal(submission.candidates[0].role, "management");
  assert.equal(submission.candidates[0].needsApproval, true);
  assert.equal(submission.candidates[0].officialSourceType, null);
  assert.equal(submission.directOutreach, null);
});

test("approval flag requires direct official-source evidence", () => {
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "candidates",
        claimToken: "claim-1",
        candidates: [
          {
            email: "manager@example.com",
            role: "management",
            sourceUrls: ["https://example.com/press"],
            evidence: "A press article inferred this address.",
            confidence: "medium",
            needsApproval: false,
            officialSource: null,
          },
        ],
      }),
    /needsApproval may be false only/
  );
});

test("requires evidence and bounded claim limits", () => {
  assert.equal(parseContactResearchClaimLimit(undefined), 3);
  assert.equal(parseContactResearchClaimLimit(10), 10);
  assert.throws(() => parseContactResearchClaimLimit(0), /limit/);
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "candidates",
        claimToken: "claim-1",
        candidates: [
          {
            email: "manager@example.com",
            role: "management",
            sourceUrls: [],
            evidence: "guess",
            confidence: "low",
          },
        ],
      }),
    /source URL/
  );
});

test("parses agent-rule skip outcomes with required provenance", () => {
  assert.deepEqual(
    parseContactResearchSubmission({
      outcome: "skipped",
      claimToken: "claim-1",
      notes: "Metatone artist",
      ruleVersion: 7,
      ruleText: "Skip artists managed by a Metatone manager.",
    }),
    {
      outcome: "skipped",
      claimToken: "claim-1",
      notes: "Metatone artist",
      ruleVersion: 7,
      ruleText: "Skip artists managed by a Metatone manager.",
      candidates: [],
    }
  );
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "skipped",
        claimToken: "claim-1",
        notes: "Metatone artist",
        ruleText: "Skip artists managed by a Metatone manager.",
      }),
    /ruleVersion/
  );
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "skipped",
        claimToken: "claim-1",
        notes: "Metatone artist",
        ruleVersion: 7,
        ruleText: "",
      }),
    /ruleText is required/
  );
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "skipped",
        claimToken: "claim-1",
        notes: "Metatone artist",
        ruleVersion: 7,
        ruleText: "Skip artists managed by a Metatone manager.",
        candidates: [{ email: "manager@example.com" }],
      }),
    /cannot include candidates/
  );
});

test("accepts only exact rules from the trusted claim snapshot", () => {
  const rules = [
    "Prefer official sources.",
    "Skip artists managed by a Metatone manager.",
  ].join("\n");
  assert.equal(
    isTrustedAgentSkipRuleProvenance(
      7,
      rules,
      7,
      "Skip artists managed by a Metatone manager."
    ),
    true
  );
  assert.equal(
    isTrustedAgentSkipRuleProvenance(
      7,
      rules,
      6,
      "Skip artists managed by a Metatone manager."
    ),
    false
  );
  assert.equal(
    isTrustedAgentSkipRuleProvenance(7, rules, 7, "Metatone"),
    false
  );
  assert.equal(
    isTrustedAgentSkipRuleProvenance(0, "", 1, "Skip this artist."),
    false
  );
});

test("artist notes reuse an existing claimed job and invalidate stale ownership", async () => {
  const updates: unknown[] = [];
  const result = await updateContactResearchArtistUserNotes(
    "artist-1",
    " Check the official management page first. ",
    {
      now: new Date("2026-07-20T12:00:00.000Z"),
      runTransaction: runWithTransaction({
        contactResearchJob: {
          findUnique: async () => ({
            id: "job-1",
            artistId: "artist-1",
            status: "claimed",
          }),
          update: async (value: unknown) => {
            updates.push(value);
            return {};
          },
        },
      }),
    }
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: "job-1",
    status: "pending",
  });
  assert.deepEqual(updates, [
    {
      where: { id: "job-1" },
      data: {
        userNotes: "Check the official management page first.",
        status: "pending",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    },
  ]);
});

test("artist notes materialize one inactive job without queueing research", async () => {
  const upserts: unknown[] = [];
  const updates: unknown[] = [];
  const now = new Date("2026-07-20T12:00:00.000Z");
  const showDate = new Date("2026-08-20T00:00:00.000Z");
  const result = await updateContactResearchArtistUserNotes(
    "artist-1",
    "Use the festival website.",
    {
      now,
      requestedShowId: "festival-1",
      runTransaction: runWithTransaction({
        contactResearchJob: {
          findUnique: async () => null,
          upsert: async (value: unknown) => {
            upserts.push(value);
            return {
              id: "job-1",
              artistId: "artist-1",
              status: "inactive",
            };
          },
          update: async (value: unknown) => {
            updates.push(value);
            return {};
          },
        },
        artist: {
          findUnique: async () => ({ id: "artist-1", contacts: [] }),
        },
        showArtist: {
          findFirst: async () => ({
            showId: "festival-1",
            show: { date: showDate },
          }),
        },
      }),
    }
  );

  assert.deepEqual(result, {
    ok: true,
    jobId: "job-1",
    status: "inactive",
  });
  assert.deepEqual(upserts, [
    {
      where: { artistId: "artist-1" },
      create: {
        artistId: "artist-1",
        requestedShowId: "festival-1",
        status: "inactive",
        nextShowAt: showDate,
      },
      update: {},
      select: { id: true, artistId: true, status: true },
    },
  ]);
  assert.deepEqual(updates, [
    {
      where: { id: "job-1" },
      data: { userNotes: "Use the festival website." },
    },
  ]);
});

test("artist skip materializes a skipped job and explicit unskip restores eligibility", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const showDate = new Date("2026-08-20T00:00:00.000Z");
  const skipCreates: unknown[] = [];
  const jobUpdates: unknown[] = [];
  const skipped = await skipContactResearchArtistByArtistId(
    "artist-1",
    " Existing relationship ",
    {
      now,
      requestedShowId: "festival-1",
      runTransaction: runWithTransaction({
        contactResearchJob: {
          findUnique: async () => null,
          upsert: async () => ({
            id: "job-1",
            artistId: "artist-1",
            status: "inactive",
          }),
          update: async (value: unknown) => {
            jobUpdates.push(value);
            return {};
          },
        },
        artist: {
          findUnique: async () => ({ id: "artist-1", contacts: [] }),
        },
        showArtist: {
          findFirst: async () => ({
            showId: "festival-1",
            show: { date: showDate },
          }),
        },
        artistResearchSkip: {
          findFirst: async () => null,
          create: async (value: unknown) => {
            skipCreates.push(value);
            return {};
          },
        },
      }),
    }
  );
  assert.deepEqual(skipped, {
    ok: true,
    jobId: "job-1",
    status: "skipped",
  });
  assert.deepEqual(skipCreates, [
    {
      data: {
        artistId: "artist-1",
        source: "manual",
        reason: "Existing relationship",
        setAt: now,
      },
    },
  ]);
  assert.equal(
    (jobUpdates[0] as { data: { status: string } }).data.status,
    "skipped"
  );

  const cleared: unknown[] = [];
  const restored: unknown[] = [];
  const unskipped = await unskipContactResearchArtistByArtistId("artist-1", {
    now,
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-1",
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          restored.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async (value: unknown) => {
          cleared.push(value);
          return {};
        },
      },
      showArtist: {
        findFirst: async () => ({ showId: "festival-1" }),
      },
    }),
  });
  assert.deepEqual(unskipped, {
    ok: true,
    jobId: "job-1",
    status: "pending",
  });
  assert.deepEqual(cleared, [
    {
      where: { id: "skip-1" },
      data: { clearedAt: now, clearedBy: "manual" },
    },
  ]);
  assert.equal(
    (restored[0] as { data: { status: string } }).data.status,
    "pending"
  );
});

test("artist unskip restores a validated festival return context", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const showQueries: unknown[] = [];
  const skipUpdates: unknown[] = [];
  const jobUpdates: unknown[] = [];
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now,
    requestedShowId: "festival-1",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: null,
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          jobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async (value: unknown) => {
          skipUpdates.push(value);
          return {};
        },
      },
      showArtist: {
        findFirst: async (value: unknown) => {
          showQueries.push(value);
          return { showId: "festival-1" };
        },
      },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    jobId: "job-1",
    status: "pending",
  });
  assert.equal(showQueries.length, 1);
  assert.deepEqual(
    (
      showQueries[0] as {
        where: {
          artistId: string;
          showId: string;
          show: {
            isFestival: boolean;
            syncStatus: string;
            date: { gte: Date };
            AND: unknown[];
          };
        };
      }
    ).where,
    {
      artistId: "artist-1",
      showId: "festival-1",
      show: {
        isFestival: true,
        syncStatus: "active",
        date: { gte: new Date("2026-07-20T00:00:00.000Z") },
        AND: [festivalLeadTimeWhere(now)],
      },
    }
  );
  assert.deepEqual(skipUpdates, [
    {
      where: { id: "skip-1" },
      data: { clearedAt: now, clearedBy: "manual" },
    },
  ]);
  assert.deepEqual(jobUpdates, [
    {
      where: { id: "job-1" },
      data: { requestedShowId: "festival-1" },
    },
    {
      where: { id: "job-1" },
      data: {
        status: "pending",
        completedAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    },
  ]);
});

test("artist unskip rejects mismatched or ineligible festival context without writes", async () => {
  for (const blockedBy of [
    "mismatched_artist",
    "inactive",
    "past",
    "lead_time_excluded",
  ]) {
    let skipUpdated = false;
    let jobUpdated = false;
    const result = await unskipContactResearchArtistByArtistId("artist-1", {
      now: new Date("2026-07-20T12:00:00.000Z"),
      requestedShowId: `festival-${blockedBy}`,
      runTransaction: runWithTransaction({
        contactResearchJob: {
          findUnique: async () => ({
            id: "job-1",
            artistId: "artist-1",
            status: "skipped",
            requestedShowId: null,
            artist: { contacts: [] },
          }),
          update: async () => {
            jobUpdated = true;
            return {};
          },
        },
        artistResearchSkip: {
          findFirst: async () => ({ id: "skip-1" }),
          update: async () => {
            skipUpdated = true;
            return {};
          },
        },
        showArtist: {
          findFirst: async () => null,
        },
      }),
    });

    assert.deepEqual(
      result,
      { ok: false, reason: "ineligible" },
      blockedBy
    );
    assert.equal(skipUpdated, false, blockedBy);
    assert.equal(jobUpdated, false, blockedBy);
  }
});

test("artist unskip festival context requires the artist to still lack an active email contact", async () => {
  let skipUpdated = false;
  let jobUpdated = false;
  let showQueried = false;
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now: new Date("2026-07-20T12:00:00.000Z"),
    requestedShowId: "festival-1",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-stale",
          artist: { contacts: [{ id: "contact-1" }] },
        }),
        update: async () => {
          jobUpdated = true;
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async () => {
          skipUpdated = true;
          return {};
        },
      },
      showArtist: {
        findFirst: async () => {
          showQueried = true;
          return null;
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: false, reason: "active_contact" });
  assert.equal(showQueried, false);
  assert.equal(skipUpdated, false);
  assert.equal(jobUpdated, false);
});

test("artist unskip gives a valid stored requested festival precedence", async () => {
  const showIds: string[] = [];
  const jobUpdates: unknown[] = [];
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now: new Date("2026-07-20T12:00:00.000Z"),
    requestedShowId: "festival-from-return",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-existing",
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          jobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async () => ({}),
      },
      showArtist: {
        findFirst: async (value: unknown) => {
          const showId = (value as { where: { showId: string } }).where
            .showId;
          showIds.push(showId);
          return { showId };
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(showIds, [
    "festival-existing",
    "festival-from-return",
  ]);
  assert.equal(
    "requestedShowId" in
      (jobUpdates[0] as { data: Record<string, unknown> }).data,
    false
  );
});

test("artist unskip rejects invalid supplied context even when stored festival is valid", async () => {
  const showIds: string[] = [];
  let skipUpdated = false;
  let jobUpdated = false;
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now: new Date("2026-07-20T12:00:00.000Z"),
    requestedShowId: "festival-forged-return",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-existing",
          artist: { contacts: [] },
        }),
        update: async () => {
          jobUpdated = true;
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async () => {
          skipUpdated = true;
          return {};
        },
      },
      showArtist: {
        findFirst: async (value: unknown) => {
          const showId = (value as { where: { showId: string } }).where
            .showId;
          showIds.push(showId);
          return showId === "festival-existing" ? { showId } : null;
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: false, reason: "ineligible" });
  assert.deepEqual(showIds, [
    "festival-existing",
    "festival-forged-return",
  ]);
  assert.equal(skipUpdated, false);
  assert.equal(jobUpdated, false);
});

test("artist unskip replaces a stale stored festival with valid supplied context", async () => {
  const showIds: string[] = [];
  const skipUpdates: unknown[] = [];
  const jobUpdates: unknown[] = [];
  const now = new Date("2026-07-20T12:00:00.000Z");
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now,
    requestedShowId: "festival-from-return",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-stale",
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          jobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async (value: unknown) => {
          skipUpdates.push(value);
          return {};
        },
      },
      showArtist: {
        findFirst: async (value: unknown) => {
          const showId = (value as { where: { showId: string } }).where
            .showId;
          showIds.push(showId);
          return showId === "festival-from-return"
            ? { showId }
            : null;
        },
      },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    jobId: "job-1",
    status: "pending",
  });
  assert.deepEqual(showIds, [
    "festival-stale",
    "festival-from-return",
  ]);
  assert.deepEqual(jobUpdates, [
    {
      where: { id: "job-1" },
      data: { requestedShowId: "festival-from-return" },
    },
    {
      where: { id: "job-1" },
      data: {
        status: "pending",
        completedAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    },
  ]);
  assert.deepEqual(skipUpdates, [
    {
      where: { id: "skip-1" },
      data: { clearedAt: now, clearedBy: "manual" },
    },
  ]);
});

test("artist unskip leaves stale stored and invalid supplied festivals untouched", async () => {
  const showIds: string[] = [];
  let skipUpdated = false;
  let jobUpdated = false;
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now: new Date("2026-07-20T12:00:00.000Z"),
    requestedShowId: "festival-invalid-return",
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: "festival-stale",
          artist: { contacts: [] },
        }),
        update: async () => {
          jobUpdated = true;
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async () => {
          skipUpdated = true;
          return {};
        },
      },
      showArtist: {
        findFirst: async (value: unknown) => {
          showIds.push(
            (value as { where: { showId: string } }).where.showId
          );
          return null;
        },
      },
    }),
  });

  assert.deepEqual(result, { ok: false, reason: "ineligible" });
  assert.deepEqual(showIds, [
    "festival-stale",
    "festival-invalid-return",
  ]);
  assert.equal(skipUpdated, false);
  assert.equal(jobUpdated, false);
});

test("non-festival unskip requires current regular-show eligibility", async () => {
  let skipUpdated = false;
  let jobUpdated = false;
  const result = await unskipContactResearchArtistByArtistId("artist-1", {
    now: new Date("2026-07-20T12:00:00.000Z"),
    runTransaction: runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          status: "skipped",
          requestedShowId: null,
          artist: { contacts: [] },
        }),
        update: async () => {
          jobUpdated = true;
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async () => {
          skipUpdated = true;
          return {};
        },
      },
      showArtist: {
        findFirst: async () => null,
      },
    }),
  });

  assert.deepEqual(result, { ok: false, reason: "ineligible" });
  assert.equal(skipUpdated, false);
  assert.equal(jobUpdated, false);
});

test("concurrent artist unskip clears once and creates no duplicate job", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const state = {
    activeSkip: true,
    jobStatus: "skipped",
    requestedShowId: "festival-stale" as string | null,
  };
  let transactionTail = Promise.resolve();
  let skipUpdateCount = 0;
  let jobUpdateCount = 0;
  const tx = {
    contactResearchJob: {
      findUnique: async () => ({
        id: "job-1",
        artistId: "artist-1",
        status: state.jobStatus,
        requestedShowId: state.requestedShowId,
        artist: { contacts: [] },
      }),
      update: async (value: unknown) => {
        const data = (value as {
          data: { status?: string; requestedShowId?: string };
        }).data;
        jobUpdateCount += 1;
        state.jobStatus = data.status ?? state.jobStatus;
        state.requestedShowId =
          data.requestedShowId ?? state.requestedShowId;
        return {};
      },
    },
    artistResearchSkip: {
      findFirst: async () => (state.activeSkip ? { id: "skip-1" } : null),
      update: async () => {
        skipUpdateCount += 1;
        state.activeSkip = false;
        return {};
      },
    },
    showArtist: {
      findFirst: async (value: unknown) => {
        const showId = (value as { where: { showId: string } }).where
          .showId;
        return showId === "festival-1" ? { showId } : null;
      },
    },
  };
  const serialRunner: ContactResearchTransactionRunner = async (work) => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(tx as unknown as Prisma.TransactionClient);
    } finally {
      release();
    }
  };

  const results = await Promise.all([
    unskipContactResearchArtistByArtistId("artist-1", {
      now,
      requestedShowId: "festival-1",
      runTransaction: serialRunner,
    }),
    unskipContactResearchArtistByArtistId("artist-1", {
      now,
      requestedShowId: "festival-1",
      runTransaction: serialRunner,
    }),
  ]);

  assert.deepEqual(results, [
    { ok: true, jobId: "job-1", status: "pending" },
    { ok: false, reason: "not_skipped" },
  ]);
  assert.equal(skipUpdateCount, 1);
  assert.equal(jobUpdateCount, 2);
  assert.deepEqual(state, {
    activeSkip: false,
    jobStatus: "pending",
    requestedShowId: "festival-1",
  });
});

test("concurrent artist note actions reuse the unique artist job", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const showDate = new Date("2026-08-20T00:00:00.000Z");
  let storedJob:
    | { id: string; artistId: string; status: string }
    | null = null;
  let upsertCount = 0;
  let transactionTail = Promise.resolve();
  const tx = {
    contactResearchJob: {
      findUnique: async () => storedJob,
      upsert: async () => {
        upsertCount += 1;
        storedJob = {
          id: "job-1",
          artistId: "artist-1",
          status: "inactive",
        };
        return storedJob;
      },
      update: async () => ({}),
    },
    artist: {
      findUnique: async () => ({ id: "artist-1", contacts: [] }),
    },
    showArtist: {
      findFirst: async () => ({
        showId: "show-1",
        show: { date: showDate },
      }),
    },
  };
  const serialRunner: ContactResearchTransactionRunner = async (work) => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(tx as unknown as Prisma.TransactionClient);
    } finally {
      release();
    }
  };

  const results = await Promise.all([
    updateContactResearchArtistUserNotes("artist-1", "First note", {
      now,
      runTransaction: serialRunner,
    }),
    updateContactResearchArtistUserNotes("artist-1", "Second note", {
      now,
      runTransaction: serialRunner,
    }),
  ]);

  assert.equal(upsertCount, 1);
  assert.deepEqual(storedJob, {
    id: "job-1",
    artistId: "artist-1",
    status: "inactive",
  });
  assert.ok(results.every((result) => result.ok));
});

test("artists without jobs are not materialized when a contact or show eligibility blocks research", async () => {
  for (const blockedBy of ["active_contact", "ineligible"] as const) {
    let upserted = false;
    const result = await updateContactResearchArtistUserNotes(
      "artist-1",
      "Remember this",
      {
        now: new Date("2026-07-20T12:00:00.000Z"),
        runTransaction: runWithTransaction({
          contactResearchJob: {
            findUnique: async () => null,
            upsert: async () => {
              upserted = true;
              return {};
            },
          },
          artist: {
            findUnique: async () => ({
              id: "artist-1",
              contacts: blockedBy === "active_contact" ? [{ id: "c-1" }] : [],
            }),
          },
          showArtist: {
            findFirst: async () => null,
          },
        }),
      }
    );
    assert.deepEqual(result, { ok: false, reason: blockedBy });
    assert.equal(upserted, false);
  }
});

test("manual skip and explicit unskip preserve one job and audit history", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const skipCreates: unknown[] = [];
  const jobUpdates: unknown[] = [];
  const skipped = await skipContactResearchArtist(
    "job-1",
    " Existing relationship ",
    now,
    runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({ id: "job-1", artistId: "artist-1" }),
        update: async (value: unknown) => {
          jobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => null,
        create: async (value: unknown) => {
          skipCreates.push(value);
          return {};
        },
      },
    })
  );
  assert.equal(skipped, true);
  assert.deepEqual(skipCreates, [
    {
      data: {
        artistId: "artist-1",
        source: "manual",
        reason: "Existing relationship",
        setAt: now,
      },
    },
  ]);
  assert.deepEqual(jobUpdates, [
    {
      where: { id: "job-1" },
      data: {
        status: "skipped",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        completedAt: null,
      },
    },
  ]);

  const clearUpdates: unknown[] = [];
  const restoredJobUpdates: unknown[] = [];
  const unskipped = await unskipContactResearchArtist(
    "job-1",
    now,
    runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          requestedShowId: null,
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          restoredJobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () => ({ id: "skip-1" }),
        update: async (value: unknown) => {
          clearUpdates.push(value);
          return {};
        },
      },
      showArtist: {
        findFirst: async () => ({ showId: "show-1" }),
      },
    })
  );
  assert.equal(unskipped, true);
  assert.deepEqual(clearUpdates, [
    {
      where: { id: "skip-1" },
      data: { clearedAt: now, clearedBy: "manual" },
    },
  ]);
  assert.deepEqual(restoredJobUpdates, [
    {
      where: { id: "job-1" },
      data: {
        status: "pending",
        completedAt: null,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    },
  ]);
});

test("queue refresh evaluates eligibility after a concurrent explicit unskip", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const state = {
    activeSkip: true,
    jobStatus: "skipped",
  };
  let eligibilityReads = 0;
  let enterRefreshTransaction!: () => void;
  let releaseRefreshTransaction!: () => void;
  const refreshTransactionEntered = new Promise<void>((resolve) => {
    enterRefreshTransaction = resolve;
  });
  const refreshTransactionRelease = new Promise<void>((resolve) => {
    releaseRefreshTransaction = resolve;
  });

  const refresh = refreshContactResearchQueue(
    now,
    async (work) => {
      enterRefreshTransaction();
      await refreshTransactionRelease;
      return work({
        showArtist: {
          findMany: async () => {
            eligibilityReads += 1;
            return state.activeSkip
              ? []
              : [
                  {
                    artistId: "artist-1",
                    show: {
                      date: new Date("2026-07-25T00:00:00.000Z"),
                      interestedAt: null,
                    },
                    artist: {
                      popularity: 50,
                      listenSignals: [],
                    },
                  },
                ];
          },
        },
        contactResearchJob: {
          findMany: async (value: unknown) => {
            const input = value as {
              where?: {
                requestedShow?: unknown;
                artistId?: { in?: string[] };
              };
            };
            if (input.where?.requestedShow) return [];
            return input.where?.artistId?.in?.includes("artist-1")
              ? [
                  {
                    id: "job-1",
                    artistId: "artist-1",
                    status: state.jobStatus,
                  },
                ]
              : [];
          },
          updateMany: async (value: unknown) => {
            const input = value as {
              where?: { artistId?: { notIn?: string[] } };
              data?: { status?: string };
            };
            if (
              input.data?.status === "inactive" &&
              state.jobStatus === "pending" &&
              !input.where?.artistId?.notIn?.includes("artist-1")
            ) {
              state.jobStatus = "inactive";
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
        contactResearchCandidate: {
          findMany: async () => [],
        },
        $executeRaw: async () => {
          state.jobStatus = "pending";
          return 1;
        },
      } as unknown as Prisma.TransactionClient);
    }
  );

  await refreshTransactionEntered;
  assert.equal(
    eligibilityReads,
    0,
    "eligibility must not be read before the serializable transaction starts"
  );

  const unskipped = await unskipContactResearchArtist(
    "job-1",
    now,
    runWithTransaction({
      contactResearchJob: {
        findUnique: async () => ({
          id: "job-1",
          artistId: "artist-1",
          requestedShowId: null,
          artist: { contacts: [] },
        }),
        update: async (value: unknown) => {
          const input = value as { data: { status: string } };
          state.jobStatus = input.data.status;
          return {};
        },
      },
      artistResearchSkip: {
        findFirst: async () =>
          state.activeSkip ? { id: "skip-1" } : null,
        update: async () => {
          state.activeSkip = false;
          return {};
        },
      },
      showArtist: {
        findFirst: async () => ({ showId: "show-1" }),
      },
    })
  );
  assert.equal(unskipped, true);
  assert.equal(state.jobStatus, "pending");

  releaseRefreshTransaction();
  const refreshed = await refresh;
  assert.equal(eligibilityReads, 1);
  assert.equal(refreshed.eligible, 1);
  assert.equal(state.jobStatus, "pending");
});

test("agent-rule skip is atomic, creates no contact, and rejects stale claims", async () => {
  const now = new Date("2026-07-20T12:00:00.000Z");
  const skipCreates: unknown[] = [];
  const jobUpdates: unknown[] = [];
  const submission = {
    outcome: "skipped",
    claimToken: "claim-1",
    notes: "Metatone artist",
    ruleVersion: 4,
    ruleText: "Skip artists managed by a Metatone manager.",
  };
  const result = await submitContactResearchResult(
    "job-1",
    submission,
    now,
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () => ({
          id: "job-1",
          artistId: "artist-1",
          claimedAgentRules:
            "Skip artists managed by a Metatone manager.",
          claimedAgentRulesVersion: 4,
        }),
        update: async (value: unknown) => {
          jobUpdates.push(value);
          return {};
        },
      },
      artistResearchSkip: {
        create: async (value: unknown) => {
          skipCreates.push(value);
          return {};
        },
      },
    })
  );
  assert.deepEqual(result, {
    accepted: true,
    status: "skipped",
    autoApproved: 0,
    sheetErrors: [],
  });
  assert.deepEqual(skipCreates, [
    {
      data: {
        artistId: "artist-1",
        source: "agent",
        reason: "Metatone artist",
        sourceJobId: "job-1",
        agentRuleVersion: 4,
        agentRuleText:
          "Skip artists managed by a Metatone manager.",
        setAt: now,
      },
    },
  ]);
  assert.deepEqual(jobUpdates, [
    {
      where: { id: "job-1" },
      data: {
        status: "skipped",
        agentNotes: "Metatone artist",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        completedAt: null,
      },
    },
  ]);

  let wroteStaleResult = false;
  const stale = await submitContactResearchResult(
    "job-1",
    submission,
    now,
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () => null,
        update: async () => {
          wroteStaleResult = true;
        },
      },
      artistResearchSkip: {
        create: async () => {
          wroteStaleResult = true;
        },
      },
    })
  );
  assert.deepEqual(stale, {
    accepted: false,
    status: "conflict",
    autoApproved: 0,
    sheetErrors: [],
  });
  assert.equal(wroteStaleResult, false);
});

test("agent skip rejects provenance outside the claim snapshot without writes", async () => {
  let wroteResult = false;
  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "skipped",
      claimToken: "claim-1",
      notes: "Metatone artist",
      ruleVersion: 5,
      ruleText: "Skip all artists.",
    },
    new Date("2026-07-20T12:00:00.000Z"),
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () => ({
          id: "job-1",
          artistId: "artist-1",
          claimedAgentRules:
            "Skip artists managed by a Metatone manager.",
          claimedAgentRulesVersion: 4,
        }),
        update: async () => {
          wroteResult = true;
        },
      },
      artistResearchSkip: {
        create: async () => {
          wroteResult = true;
        },
      },
    })
  );
  assert.deepEqual(result, {
    accepted: false,
    status: "invalid_rule_provenance",
    autoApproved: 0,
    sheetErrors: [],
  });
  assert.equal(wroteResult, false);
});

test("prioritizes interested, matched, popular, and imminent artists", () => {
  const routine = contactResearchPriority({
    interested: false,
    hasActiveSignal: false,
    popularity: 60,
    daysUntilShow: 60,
  });
  const urgent = contactResearchPriority({
    interested: true,
    hasActiveSignal: true,
    popularity: 80,
    daysUntilShow: 5,
  });
  assert.ok(urgent > routine);
});

test("contact research bearer authorization fails closed", async () => {
  assert.equal(
    await isValidContactResearchAuthorization("Bearer correct", "correct"),
    true
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer wrong", "correct"),
    false
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer correct", []),
    false
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer cron-secret", [
      "dedicated",
      "cron-secret",
    ]),
    true
  );
  assert.equal(
    await isValidContactResearchAuthorization(
      "Bearer oidc-token",
      [],
      async (token) => token === "oidc-token"
    ),
    true
  );
});

test("GitHub Actions OIDC claims are pinned to the research workflow", () => {
  const trusted = {
    aud: CONTACT_RESEARCH_OIDC_AUDIENCE,
    repository: "zspherez/photo-admin",
    repository_owner: "zspherez",
    ref: "refs/heads/main",
    workflow_ref: CONTACT_RESEARCH_WORKFLOW_REF,
    event_name: "workflow_dispatch",
  };
  assert.equal(isTrustedContactResearchOidcClaims(trusted), true);
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      ref: "refs/heads/untrusted",
    }),
    false
  );
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      workflow_ref:
        "zspherez/photo-admin/.github/workflows/other.yml@refs/heads/main",
    }),
    false
  );
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      event_name: "pull_request",
    }),
    false
  );
});

test("claims require current eligibility and unexpired ownership", () => {
  const source = readFileSync(
    new URL("./contactResearch.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /claimExpiresAt: \{ gt: now \}/);
  assert.match(
    source,
    /ArtistResearchSkip[\s\S]*research_skip\."clearedAt" IS NULL/
  );
  assert.ok(
    (source.match(/researchSkips: \{\s*none: \{ clearedAt: null \}/g) ?? [])
      .length >= 3
  );
  assert.match(source, /show\."syncStatus" = 'active'/);
  assert.match(source, /status: "inactive"/);
  assert.match(source, /job\."requestedShowId" = show\."id"/);
  assert.match(source, /showArtist\.artistId === row\.artistId/);
  assert.doesNotMatch(
    source,
    /COALESCE\(contact\."role"/
  );
  assert.match(
    source,
    /submitContactResearchResult[\s\S]*await runTransaction\(async \(tx\) => \{[\s\S]*claimExpiresAt: \{ gt: now \}/
  );
  assert.match(source, /prepareContactResearchQueue/);
  assert.match(source, /claimable/);
  assert.match(source, /readGlobalAgentRulesInTransaction\(tx\)/);
  assert.match(source, /claimedAgentRules: globalAgentRules\.instructions/);
  assert.match(
    source,
    /claimedAgentRulesVersion: globalAgentRules\.version/
  );
  assert.match(source, /globalAgentRules: \{/);
  assert.match(source, /instructions: job\.claimedAgentRules \?\? ""/);
  assert.match(source, /researchInstructions: job\.userNotes/);
  assert.match(
    source,
    /submission\.outcome === "skipped"[\s\S]*artistResearchSkip\.create[\s\S]*status: "skipped"[\s\S]*claimToken: null/
  );
  assert.match(
    source,
    /skipContactResearchArtist[\s\S]*source: "manual"[\s\S]*status: "skipped"/
  );
  const unskipSource = source.slice(
    source.indexOf("export async function unskipContactResearchArtist"),
    source.indexOf("export async function retryContactResearchJob")
  );
  assert.match(unskipSource, /reason: "active_contact"/);
  assert.match(
    unskipSource,
    /eligibleFestival[\s\S]*isFestival: true[\s\S]*syncStatus: "active"[\s\S]*festivalLeadTimeWhere\(now\)/
  );
  assert.match(
    unskipSource,
    /eligibleStoredRequestedShow[\s\S]*eligibleSuppliedRequestedShow[\s\S]*restoredRequestedShowId/
  );
  assert.match(
    unskipSource,
    /suppliedRequestedShowId && !eligibleSuppliedRequestedShow[\s\S]*reason: "ineligible"/
  );
  assert.match(
    unskipSource,
    /!restoredRequestedShowId && !eligibleRegularShow[\s\S]*reason: "ineligible"/
  );
  assert.match(
    unskipSource,
    /requestedShowId: restoredRequestedShowId[\s\S]*clearedBy: "manual"[\s\S]*status: "pending"/
  );
  assert.doesNotMatch(unskipSource, /contactResearchJob\.create/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf('if (submission.outcome === "skipped")'),
      source.indexOf('if (submission.outcome === "exhausted")')
    ),
    /contactResearchCandidate\.(create|upsert)|contact\.(create|upsert)/
  );
  assert.match(
    source,
    /retryContactResearchJob[\s\S]*retryEligibleContactResearchJobs/
  );
  assert.match(
    source,
    /retryAllExhaustedContactResearchJobs[\s\S]*retryContactResearchJobsByStatus\("exhausted"\)/
  );
  assert.match(
    source,
    /retryAllReviewContactResearchJobs[\s\S]*retryContactResearchJobsByStatus\("review"\)/
  );
  assert.match(
    source,
    /retryEligibleContactResearchJobs[\s\S]*show\."syncStatus" = 'active'[\s\S]*show\."date" <= \$\{end\}[\s\S]*job\."requestedShowId" = show\."id"/
  );
  assert.match(
    source,
    /retryEligibleContactResearchJobs[\s\S]*ArtistResearchSkip[\s\S]*research_skip\."clearedAt" IS NULL/
  );
});
