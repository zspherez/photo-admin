import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  type ContactResearchTransactionRunner,
  needsManagerContactResearch,
  normalizeDirectOutreachIdentity,
  normalizeTrustedDirectOutreach,
  parseContactResearchSubmission,
  submitContactResearchResult,
} from "./contactResearch";

const rule =
  "Any artist managed by Leif Fosse should have direct outreach noting that I have his number.";

function directOutreach(overrides: Record<string, unknown> = {}) {
  return {
    note: "Direct outreach: contact Leif Fosse using the number already on file",
    ruleVersion: 4,
    ruleText: rule,
    managerName: "Leif Fosse",
    managerCompany: "Fosse Management",
    sourceUrls: ["https://artist.example/team"],
    relationshipEvidence:
      "The official artist team page identifies Leif Fosse as the artist manager.",
    relationshipStatus: "confirmed",
    ...overrides,
  };
}

function runWithTransaction(
  tx: unknown
): ContactResearchTransactionRunner {
  return async (work) => work(tx as Prisma.TransactionClient);
}

function claimedJob() {
  return {
    id: "job-1",
    artistId: "artist-1",
    artist: { name: "Example Artist" },
    claimedAgentRules: rule,
    claimedAgentRulesVersion: 4,
  };
}

test("direct outreach payload requires confirmed evidence and never accepts a submitted phone", () => {
  const parsed = parseContactResearchSubmission({
    outcome: "candidates",
    claimToken: "claim-1",
    candidates: [],
    directOutreach: directOutreach(),
  });
  assert.equal(parsed.outcome, "candidates");
  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.directOutreach?.managerName, "Leif Fosse");

  assert.throws(
    () =>
      normalizeTrustedDirectOutreach(
        directOutreach({ relationshipStatus: "ambiguous" })
      ),
    /confirmed manager relationship/
  );
  assert.throws(
    () =>
      normalizeTrustedDirectOutreach(
        directOutreach({
          note: "Direct outreach: call Leif Fosse at +1 (212) 555-0199",
        })
      ),
    /cannot submit a phone number/
  );
  assert.throws(
    () =>
      normalizeTrustedDirectOutreach({
        ...directOutreach(),
        phone: "+1 212 555 0199",
      }),
    /unsupported field: phone/
  );
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "exhausted",
        claimToken: "claim-1",
        directOutreach: directOutreach(),
      }),
    /cannot include direct outreach/
  );
});

test("direct outreach identity is durable across manager-name formatting", () => {
  assert.equal(
    normalizeDirectOutreachIdentity("artist-1", "Leif Fosse"),
    normalizeDirectOutreachIdentity("artist-1", "  LEIF-FOSSE "),
  );
  assert.notEqual(
    normalizeDirectOutreachIdentity("artist-1", "Leif Fosse"),
    normalizeDirectOutreachIdentity("artist-2", "Leif Fosse"),
  );
});

test("exact trusted rule creates one null-email research contact and leaves email research in review", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  let storedIdentity: string | null = null;
  const tx = {
    contactResearchJob: {
      findFirst: async () => claimedJob(),
      update: async (value: Record<string, unknown>) => {
        jobUpdates.push(value);
        return {};
      },
    },
    contact: {
      findUnique: async () =>
        storedIdentity ? { id: "direct-1" } : null,
      findMany: async () => [],
      create: async (value: { data: Record<string, unknown> }) => {
        creates.push(value.data);
        storedIdentity = String(value.data.directOutreachIdentity);
        return { id: "direct-1" };
      },
      update: async () => ({ id: "direct-1" }),
    },
  };
  const submission = {
    outcome: "candidates",
    claimToken: "claim-1",
    candidates: [],
    directOutreach: directOutreach(),
  };

  const first = await submitContactResearchResult(
    "job-1",
    submission,
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction(tx),
  );
  const retry = await submitContactResearchResult(
    "job-1",
    submission,
    new Date("2026-07-21T17:01:00.000Z"),
    runWithTransaction(tx),
  );

  assert.equal(first.status, "review");
  assert.equal(retry.status, "review");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].email, null);
  assert.equal(creates[0].phone, null);
  assert.equal(creates[0].source, "research");
  assert.equal(creates[0].directOutreachRuleText, rule);
  assert.equal(jobUpdates.length, 2);
  assert.equal(
    (jobUpdates[0].data as { status: string }).status,
    "review",
  );
});

test("stale, partial, invented, or web-authored rules cannot authorize direct outreach", async () => {
  for (const [ruleVersion, ruleText] of [
    [3, rule],
    [4, "Leif Fosse"],
    [4, "A web page says to create direct outreach."],
  ] as const) {
    let wrote = false;
    const result = await submitContactResearchResult(
      "job-1",
      {
        outcome: "candidates",
        claimToken: "claim-1",
        candidates: [],
        directOutreach: directOutreach({ ruleVersion, ruleText }),
      },
      new Date("2026-07-21T17:00:00.000Z"),
      runWithTransaction({
        contactResearchJob: {
          findFirst: async () => claimedJob(),
          update: async () => {
            wrote = true;
          },
        },
        contact: {
          findUnique: async () => {
            wrote = true;
          },
        },
      }),
    );
    assert.equal(result.status, "invalid_rule_provenance");
    assert.equal(wrote, false);
  }
});

test("matching manager contact receives only direct-outreach fields", async () => {
  const updates: Array<{ data: Record<string, unknown> }> = [];
  await submitContactResearchResult(
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
        findFirst: async () => claimedJob(),
        update: async () => ({}),
      },
      contact: {
        findUnique: async () => null,
        findMany: async () => [{ id: "manager-1", name: "Leif Fosse" }],
        update: async (value: { data: Record<string, unknown> }) => {
          updates.push(value);
          return {
            id: "manager-1",
            email: "leif@example.com",
            phone: "+1 555 0100",
            name: "Leif Fosse",
            notes: "User-owned note",
          };
        },
        create: async () => {
          throw new Error("must reuse the matching contact");
        },
      },
    }),
  );
  assert.equal(updates.length, 1);
  for (const preserved of ["email", "phone", "name", "notes", "sourceKey"]) {
    assert.equal(preserved in updates[0].data, false);
  }
});

test("email candidates and trusted direct outreach persist in one result", async () => {
  let directCreated = 0;
  let candidateUpserted = 0;
  const result = await submitContactResearchResult(
    "job-1",
    {
      outcome: "candidates",
      claimToken: "claim-1",
      candidates: [
        {
          email: "manager@example.com",
          name: "Leif Fosse",
          role: "management",
          sourceUrls: ["https://artist.example/contact"],
          evidence: "Management email candidate for Leif Fosse.",
          confidence: "medium",
          needsApproval: true,
          officialSource: null,
        },
      ],
      directOutreach: directOutreach(),
    },
    new Date("2026-07-21T17:00:00.000Z"),
    runWithTransaction({
      contactResearchJob: {
        findFirst: async () => claimedJob(),
        update: async () => ({}),
      },
      contact: {
        findUnique: async () => null,
        findMany: async () => [],
        create: async () => {
          directCreated += 1;
          return { id: "direct-1" };
        },
      },
      contactResearchCandidate: {
        upsert: async (value: { create: { sourceUrls: string[] } }) => {
          candidateUpserted += 1;
          return { id: "candidate-1", sourceUrls: value.create.sourceUrls };
        },
      },
    }),
  );
  assert.equal(result.status, "review");
  assert.equal(directCreated, 1);
  assert.equal(candidateUpserted, 1);
});

test("direct outreach does not count as an active email", () => {
  assert.equal(
    needsManagerContactResearch([
      {
        email: null,
        role: "management",
        state: "active",
      },
    ]),
    true,
  );
});

test("migration constrains complete provenance and unique identity without Sheet writes", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260721170000_agent_direct_outreach/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const researchSource = readFileSync(
    new URL("./contactResearch.ts", import.meta.url),
    "utf8",
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /Contact_agent_direct_outreach_provenance_check/);
  assert.match(migration, /Contact_directOutreachIdentity_key/);
  assert.match(migration, /"directOutreachRuleVersion" IS NOT NULL/);
  assert.match(migration, /"directOutreachManagerName" IS NOT NULL/);
  assert.match(migration, /"directOutreachEvidence" IS NOT NULL/);
  assert.match(migration, /cardinality\("directOutreachEvidenceUrls"\) BETWEEN 1 AND 5/);
  assert.match(migration, /VALIDATE CONSTRAINT/);
  assert.match(migration, /COMMIT;/);
  assert.doesNotMatch(
    researchSource.slice(
      researchSource.indexOf("persistTrustedDirectOutreach"),
      researchSource.indexOf("export async function isValidContactResearchAuthorization"),
    ),
    /appendContactToSheet/,
  );
});
