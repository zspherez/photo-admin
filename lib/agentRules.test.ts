import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH,
  GLOBAL_AGENT_RULES_MAX_LENGTH,
  directOutreachInstructionExcerptFromCanonical,
  normalizeDirectOutreachInstructions,
  normalizeGlobalAgentRules,
  readGlobalAgentRulesInTransaction,
  readStoredDirectOutreachInstructions,
  saveGlobalAgentRuleSet,
  saveGlobalAgentRules,
  type AgentRulesTransactionRunner,
} from "./agentRules";

class MemoryAgentRuleStore {
  row: {
    scope: string;
    instructions: string;
    directOutreachRules: Prisma.JsonValue;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  } | null = null;
  lockCount = 0;

  readonly runTransaction: AgentRulesTransactionRunner = async <T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    const tx = {
      $executeRaw: async () => {
        this.lockCount += 1;
        return 0;
      },
      agentRuleSet: {
        findUnique: async () => this.row,
        upsert: async (args: {
          create: {
            scope: string;
            instructions: string;
            directOutreachRules: Prisma.InputJsonValue;
            version: number;
          };
          update: {
            instructions: string;
            directOutreachRules?: Prisma.InputJsonValue;
            version: { increment: number };
          };
        }) => {
          const now = new Date();
          this.row = this.row
            ? {
                ...this.row,
                instructions: args.update.instructions,
                directOutreachRules:
                  (args.update.directOutreachRules ??
                    this.row.directOutreachRules) as Prisma.JsonValue,
                version: this.row.version + args.update.version.increment,
                updatedAt: now,
              }
            : {
                ...args.create,
                directOutreachRules:
                  args.create.directOutreachRules as Prisma.JsonValue,
                createdAt: now,
                updatedAt: now,
              };
          return this.row;
        },
      },
    } as unknown as Prisma.TransactionClient;
    return work(tx);
  };
}

test("general agent rules trim text and enforce the safe limit", () => {
  assert.equal(
    normalizeGlobalAgentRules("  Prefer official sources.  "),
    "Prefer official sources.",
  );
  assert.equal(
    normalizeGlobalAgentRules("x".repeat(GLOBAL_AGENT_RULES_MAX_LENGTH)).length,
    GLOBAL_AGENT_RULES_MAX_LENGTH,
  );
  assert.throws(
    () =>
      normalizeGlobalAgentRules(
        "x".repeat(GLOBAL_AGENT_RULES_MAX_LENGTH + 1),
      ),
    /8,000 characters or fewer/,
  );
  assert.throws(() => normalizeGlobalAgentRules(null), /must be text/);
});

test("plain-language direct outreach rules allow references but reject literals and serialization", () => {
  const leif =
    "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.";
  assert.equal(
    normalizeDirectOutreachInstructions(`  ${leif}  `),
    leif,
  );
  assert.equal(
    normalizeDirectOutreachInstructions(
      "Direct outreach should only be proposed when a trusted instruction applies.",
    ),
    "Direct outreach should only be proposed when a trusted instruction applies.",
  );
  assert.equal(
    normalizeDirectOutreachInstructions(
      "[Only propose a note when the manager relationship is public.]",
    ),
    "[Only propose a note when the manager relationship is public.]",
  );
  assert.equal(
    normalizeDirectOutreachInstructions(
      "x".repeat(DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH),
    ).length,
    DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH,
  );
  assert.throws(
    () =>
      normalizeDirectOutreachInstructions(
        "Call Leif at +1 212 555 0199.",
      ),
    /cannot contain a phone number/,
  );
  for (const value of [
    'DIRECT_OUTREACH {"id":"leif-fosse"}',
    '{"manager":"Leif Fosse"}',
    '["Leif Fosse"]',
  ]) {
    assert.throws(
      () => normalizeDirectOutreachInstructions(value),
      /plain-language sentences/,
    );
  }
});

test("direct outreach text is versioned separately and claimed exactly", async () => {
  const store = new MemoryAgentRuleStore();
  assert.deepEqual(
    await readGlobalAgentRulesInTransaction(
      {
        agentRuleSet: {
          findUnique: async () => null,
        },
      } as unknown as Prisma.TransactionClient,
    ),
    {
      scope: "global",
      instructions: "",
      directOutreachInstructions: "",
      version: 0,
      updatedAt: null,
    },
  );

  const directOutreachInstructions =
    "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.";
  const first = await saveGlobalAgentRuleSet(
    {
      instructions: "Prefer official sources.",
      directOutreachInstructions,
    },
    store.runTransaction,
  );
  const second = await saveGlobalAgentRules(
    "Prefer named contacts.",
    store.runTransaction,
  );

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.instructions, "Prefer named contacts.");
  assert.equal(
    second.directOutreachInstructions,
    directOutreachInstructions,
  );
  assert.equal(store.lockCount, 2);
  assert.deepEqual(
    await readGlobalAgentRulesInTransaction(
      {
        agentRuleSet: {
          findUnique: async () => store.row,
        },
      } as unknown as Prisma.TransactionClient,
    ),
    second,
  );
});

test("legacy structured rules convert to readable freeform text", () => {
  const legacy = [
    {
      id: "leif-fosse",
      action: "direct_outreach",
      managerName: "Leif Fosse",
      note: "Use the number already on file",
      canonicalRule:
        'DIRECT_OUTREACH {"id":"leif-fosse","manager":"Leif Fosse","note":"Use the number already on file"}',
    },
  ] as unknown as Prisma.JsonValue;
  assert.equal(
    readStoredDirectOutreachInstructions(legacy),
    "When an artist is managed by Leif Fosse, add this direct outreach note: Use the number already on file.",
  );
  assert.equal(
    directOutreachInstructionExcerptFromCanonical(
      'DIRECT_OUTREACH {"id":"leif-fosse","manager":"Leif Fosse","note":"Use the number already on file"}',
    ),
    "When an artist is managed by Leif Fosse, add this direct outreach note: Use the number already on file.",
  );
});

test("global agent rules migration preserves versioned JSON claim snapshots", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260720043000_global_agent_rules/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE "AgentRuleSet"/);
  assert.match(migration, /CHECK \("scope" = 'global'\)/);
  assert.match(migration, /char_length\("instructions"\) <= 8000/);
  assert.match(migration, /ADD COLUMN "claimedAgentRules" TEXT/);
  assert.match(migration, /ADD COLUMN "claimedAgentRulesVersion" INTEGER/);
  const structuredMigration = readFileSync(
    new URL(
      "../prisma/migrations/20260721180000_structured_direct_outreach_review/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(structuredMigration, /ADD COLUMN "directOutreachRules" JSONB/);
  assert.match(
    structuredMigration,
    /ADD COLUMN "claimedDirectOutreachRules" JSONB/,
  );
  assert.match(
    structuredMigration,
    /CREATE TABLE "ContactResearchDirectOutreachProposal"/,
  );
});
