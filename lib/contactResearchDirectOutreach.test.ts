import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  approveContactResearchDirectOutreach,
  type ContactResearchTransactionRunner,
  normalizeTrustedDirectOutreach,
  parseContactResearchSubmission,
  rejectContactResearchDirectOutreach,
  submitContactResearchResult,
} from "./contactResearch";
import { parseDirectOutreachAgentRules } from "./agentRules";

const canonicalRule =
  'DIRECT_OUTREACH {"id":"leif-fosse","manager":"Leif Fosse","note":"Use the number already on file"}';
const structuredRule = parseDirectOutreachAgentRules(canonicalRule)[0];

function directOutreach(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "leif-fosse",
    ruleVersion: 4,
    canonicalRule,
    managerName: "Leif Fosse",
    managerCompany: "Fosse Management",
    evidence: [
      {
        sourceUrl: "https://fossemanagement.com/team",
        quote: "The artist is managed by Leif Fosse.",
      },
    ],
    ...overrides,
  };
}

function runWithTransaction(
  tx: unknown,
): ContactResearchTransactionRunner {
  return async (work) => work(tx as Prisma.TransactionClient);
}

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    artistId: "artist-1",
    artist: { name: "Example Artist" },
    claimedAgentRules: "Prefer official sources.",
    claimedAgentRulesVersion: 4,
    claimedDirectOutreachRules: [structuredRule],
    ...overrides,
  };
}

test("structured direct outreach accepts positive quotes and rejects self-asserted or negative relationships", () => {
  const parsed = parseContactResearchSubmission({
    outcome: "candidates",
    claimToken: "claim-1",
    candidates: [],
    directOutreach: directOutreach(),
  });
  assert.equal(parsed.outcome, "candidates");
  assert.equal(parsed.directOutreach?.ruleId, "leif-fosse");
  assert.equal(parsed.directOutreach?.evidence.length, 1);

  for (const quote of [
    "Leif Fosse is confirmed.",
    "Leif Fosse is not the artist manager.",
    "Former manager: Leif Fosse.",
    "It is rumored that management is Leif Fosse.",
  ]) {
    assert.throws(
      () =>
        normalizeTrustedDirectOutreach(
          directOutreach({
            evidence: [
              {
                sourceUrl: "https://fossemanagement.com/team",
                quote,
              },
            ],
          }),
        ),
      /positive published manager statement/,
    );
  }
});

test("every agent-controlled field rejects phone numbers and safe IDs remain valid", () => {
  for (const overrides of [
    { managerName: "Leif +1 (212) 555-0199" },
    { managerCompany: "Fosse 020/7123/4567" },
    {
      canonicalRule:
        'DIRECT_OUTREACH {"id":"leif-fosse","manager":"Leif Fosse","note":"Call ＋٤٤／٢٠／٧١٢٣／٤٥٦٧"}',
    },
    {
      evidence: [
        {
          sourceUrl: "https://fossemanagement.com/team",
          quote: "Managed by Leif Fosse at １２３.４５６.７８９０.",
        },
      ],
    },
    {
      evidence: [
        {
          sourceUrl:
            "https://fossemanagement.com/contact/%2B1-212-555-0199",
          quote: "Managed by Leif Fosse.",
        },
      ],
    },
    {
      evidence: [
        {
          sourceUrl: "https://fossemanagement.com/team?phone=2125550199",
          quote: "Managed by Leif Fosse.",
        },
      ],
    },
  ]) {
    assert.throws(
      () => normalizeTrustedDirectOutreach(directOutreach(overrides)),
      /cannot contain a phone number/,
    );
  }
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "candidates",
        claimToken: "claim-1",
        candidates: [],
        notes: "Manager line: 5550199",
        directOutreach: directOutreach(),
      }),
    /notes cannot contain a phone number/,
  );
  assert.doesNotThrow(() =>
    normalizeTrustedDirectOutreach(
      directOutreach({
        evidence: [
          {
            sourceUrl:
              "https://edmtrain.com/artists/1234567890?eventId=1234567890",
            quote:
              "On 2026-07-21, the artist is managed by Leif Fosse.",
          },
        ],
      }),
    ),
  );
});

test("ordinary free-text rules cannot authorize and exact structured snapshots create one review proposal", async () => {
  const proposals: Array<Record<string, unknown>> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const proposalDelegate = {
    findUnique: async () => null,
    create: async (value: { data: Record<string, unknown> }) => {
      proposals.push(value.data);
      return { id: "proposal-1" };
    },
    findMany: async () => [{ status: "pending" }],
  };
  const tx = {
    contactResearchJob: {
      findFirst: async () => claimedJob(),
      update: async (value: Record<string, unknown>) => {
        jobUpdates.push(value);
        return {};
      },
    },
    contactResearchDirectOutreachProposal: proposalDelegate,
    contactResearchCandidate: {
      findMany: async () => [],
    },
    contact: {
      findMany: async () => [],
    },
  };
  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      candidates: [],
      directOutreach: directOutreach(),
    },
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction(tx),
  );
  assert.equal(result.status, "review");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].note, "Direct outreach: Use the number already on file");
  assert.equal("email" in proposals[0], false);
  assert.equal("phone" in proposals[0], false);
  assert.equal(
    (jobUpdates.at(-1)?.data as { status: string }).status,
    "review",
  );

  let wrote = false;
  const rejected = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      candidates: [],
      directOutreach: directOutreach(),
    },
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () =>
          claimedJob({ claimedDirectOutreachRules: [] }),
      },
      contactResearchDirectOutreachProposal: {
        create: async () => {
          wrote = true;
        },
      },
    }),
  );
  assert.equal(rejected.status, "invalid_rule_provenance");
  assert.equal(wrote, false);
});

test("proposal retries are idempotent and do not reopen reviewed decisions", async () => {
  let creates = 0;
  let status: "pending" | "approved" = "pending";
  const proposalDelegate = {
    findUnique: async () =>
      creates === 0 ? null : { id: "proposal-1", status },
    create: async () => {
      creates += 1;
      return { id: "proposal-1" };
    },
    update: async () => ({}),
    findMany: async () => [{ status }],
  };
  const tx = {
    contactResearchJob: {
      findFirst: async () => claimedJob(),
      update: async () => ({}),
    },
    contactResearchDirectOutreachProposal: proposalDelegate,
    contactResearchCandidate: { findMany: async () => [] },
    contact: { findMany: async () => [] },
  };
  const submission = {
    outcome: "candidates",
    claimToken: "claim-1",
    candidates: [],
    directOutreach: directOutreach(),
  };
  await submitContactResearchResult(
    "job-1",
    submission,
    new Date(),
    runWithTransaction(tx),
  );
  await submitContactResearchResult(
    "job-1",
    submission,
    new Date(),
    runWithTransaction(tx),
  );
  status = "approved";
  await submitContactResearchResult(
    "job-1",
    submission,
    new Date(),
    runWithTransaction(tx),
  );
  assert.equal(creates, 1);
});

test("human approval preserves existing contact fields and atomically records provenance", async () => {
  const contactUpdates: Array<{ data: Record<string, unknown> }> = [];
  const proposalUpdates: Array<{ data: Record<string, unknown> }> = [];
  const jobStatuses: string[] = [];
  const result = await approveContactResearchDirectOutreach(
    "proposal-1",
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchDirectOutreachProposal: {
        findFirst: async () => ({
          id: "proposal-1",
          jobId: "job-1",
          ruleVersion: 4,
          canonicalRule,
          managerName: "Leif Fosse",
          managerCompany: "Fosse Management",
          note: "Direct outreach: Use the number already on file",
          sourceUrls: ["https://fossemanagement.com/team"],
          evidenceQuotes: ["Managed by Leif Fosse."],
          job: { id: "job-1", artistId: "artist-1" },
        }),
        updateMany: async (value: { data: Record<string, unknown> }) => {
          proposalUpdates.push(value);
          return { count: 1 };
        },
        findMany: async () => [{ status: "approved" }],
      },
      contact: {
        findUnique: async () => null,
        findMany: async () => [{ id: "contact-1", name: "Leif Fosse" }],
        update: async (value: { data: Record<string, unknown> }) => {
          contactUpdates.push(value);
          return { id: "contact-1" };
        },
      },
      contactResearchCandidate: { findMany: async () => [] },
      contactResearchJob: {
        update: async (value: { data: { status: string } }) => {
          jobStatuses.push(value.data.status);
          return {};
        },
      },
    }),
  );
  assert.deepEqual(result, { ok: true, contactId: "contact-1" });
  for (const preserved of ["email", "phone", "name", "notes", "sourceKey"]) {
    assert.equal(preserved in contactUpdates[0].data, false);
  }
  assert.equal(
    contactUpdates[0].data.directOutreachRuleText,
    canonicalRule,
  );
  assert.deepEqual(proposalUpdates[0].data, {
    status: "approved",
    contactId: "contact-1",
    reviewedAt: new Date("2026-07-21T17:00:00.000Z"),
  });
  assert.deepEqual(jobStatuses, ["review"]);
});

test("human approval creates one null-email research contact when no manager contact exists", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const result = await approveContactResearchDirectOutreach(
    "proposal-1",
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchDirectOutreachProposal: {
        findFirst: async () => ({
          id: "proposal-1",
          jobId: "job-1",
          ruleVersion: 4,
          canonicalRule,
          managerName: "Leif Fosse",
          managerCompany: null,
          note: "Direct outreach: Use the number already on file",
          sourceUrls: ["https://fossemanagement.com/team"],
          evidenceQuotes: ["Managed by Leif Fosse."],
          job: { id: "job-1", artistId: "artist-1" },
        }),
        updateMany: async () => ({ count: 1 }),
        findMany: async () => [{ status: "approved" }],
      },
      contact: {
        findUnique: async () => null,
        findMany: async () => [],
        create: async (value: { data: Record<string, unknown> }) => {
          creates.push(value.data);
          return { id: "contact-new" };
        },
      },
      contactResearchCandidate: { findMany: async () => [] },
      contactResearchJob: { update: async () => ({}) },
    }),
  );
  assert.deepEqual(result, { ok: true, contactId: "contact-new" });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].email, null);
  assert.equal(creates[0].phone, null);
  assert.equal(creates[0].source, "research");
  assert.equal(creates[0].role, "management");
});

test("email candidates and direct outreach persist together without collapsing review", async () => {
  let proposalWrites = 0;
  let candidateWrites = 0;
  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      directOutreach: directOutreach(),
      candidates: [
        {
          email: "manager@example.com",
          name: "Example Manager",
          role: "management",
          sourceUrls: ["https://fossemanagement.com/team"],
          evidence:
            "Fosse Management publishes manager@example.com for Example Manager.",
          confidence: "high",
        },
      ],
    },
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () => claimedJob(),
        update: async () => ({}),
      },
      contactResearchDirectOutreachProposal: {
        findUnique: async () => null,
        create: async () => {
          proposalWrites += 1;
          return { id: "proposal-1" };
        },
        findMany: async () => [{ status: "pending" }],
      },
      contactResearchCandidate: {
        findUnique: async () => null,
        upsert: async (value: {
          create: { normalizedEmail: string };
        }) => {
          candidateWrites += 1;
          return {
            id: "candidate-1",
            sourceUrls: ["https://fossemanagement.com/team"],
            normalizedEmail: value.create.normalizedEmail,
            status: "pending",
          };
        },
        findMany: async (value: {
          where: { status?: string | { in: string[] } };
        }) =>
          value.where.status === "approved"
            ? []
            : [
                {
                  status: "pending",
                  normalizedEmail: "manager@example.com",
                },
              ],
      },
      contact: { findMany: async () => [] },
    }),
  );
  assert.equal(result.status, "review");
  assert.equal(proposalWrites, 1);
  assert.equal(candidateWrites, 1);
});

test("direct-only reviewed outcomes remain review and rejection creates no contact", async () => {
  const contactWritten = false;
  const result = await rejectContactResearchDirectOutreach(
    "proposal-1",
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchDirectOutreachProposal: {
        findFirst: async () => ({
          id: "proposal-1",
          jobId: "job-1",
          job: { artistId: "artist-1" },
        }),
        updateMany: async () => ({ count: 1 }),
        findMany: async () => [{ status: "rejected" }],
      },
      contactResearchCandidate: { findMany: async () => [] },
      contact: {
        findMany: async () => {
          if (contactWritten) throw new Error("unexpected contact");
          return [];
        },
      },
      contactResearchJob: {
        update: async (value: { data: { status: string } }) => {
          assert.equal(value.data.status, "review");
          return {};
        },
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(contactWritten, false);
});

test("migration and cross-feature paths preserve complete provenance invariants", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260721180000_structured_direct_outreach_review/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const audit = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const sheets = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  const editor = readFileSync(
    new URL("../app/dashboard/contact/[contactId]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE "ContactResearchDirectOutreachProposal"/);
  assert.match(migration, /ContactResearchDirectOutreachProposal_review_check/);
  assert.match(
    migration,
    /REFERENCES "Contact"\("id"\)\s+ON DELETE CASCADE/,
  );
  assert.match(migration, /cardinality\("sourceUrls"\) = cardinality\("evidenceQuotes"\)/);
  for (const source of [audit, sheets, editor]) {
    assert.match(source, /CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE/);
  }
  assert.match(
    audit,
    /directOutreachNote: null,[\s\S]*CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE/,
  );
});
