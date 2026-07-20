import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  GLOBAL_AGENT_RULES_MAX_LENGTH,
  normalizeGlobalAgentRules,
  readGlobalAgentRulesInTransaction,
  saveGlobalAgentRules,
  type AgentRulesTransactionRunner,
} from "./agentRules";

class MemoryAgentRuleStore {
  row: {
    scope: string;
    instructions: string;
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
            version: number;
          };
          update: {
            instructions: string;
            version: { increment: number };
          };
        }) => {
          const now = new Date();
          this.row = this.row
            ? {
                ...this.row,
                instructions: args.update.instructions,
                version: this.row.version + args.update.version.increment,
                updatedAt: now,
              }
            : {
                ...args.create,
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

test("global agent rules trim text and enforce the safe limit", () => {
  assert.equal(normalizeGlobalAgentRules("  Prefer official sources.  "), "Prefer official sources.");
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

test("global agent rule saves are versioned and readable by claim transactions", async () => {
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
      version: 0,
      updatedAt: null,
    },
  );

  const first = await saveGlobalAgentRules(
    "Prefer official sources.",
    store.runTransaction,
  );
  const second = await saveGlobalAgentRules(
    "Prefer named contacts.",
    store.runTransaction,
  );

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.instructions, "Prefer named contacts.");
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

test("global agent rules migration enforces scope, length, and claim snapshots", () => {
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
});
