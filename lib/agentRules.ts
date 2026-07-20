import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const GLOBAL_AGENT_RULES_SCOPE = "global" as const;
export const GLOBAL_AGENT_RULES_MAX_LENGTH = 8_000;

export interface GlobalAgentRulesSnapshot {
  scope: typeof GLOBAL_AGENT_RULES_SCOPE;
  instructions: string;
  version: number;
  updatedAt: Date | null;
}

export type AgentRulesTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

const runDefaultTransaction: AgentRulesTransactionRunner = (work) =>
  db.$transaction(work);

export function normalizeGlobalAgentRules(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Global agent rules must be text.");
  }
  const instructions = value.trim();
  if (instructions.length > GLOBAL_AGENT_RULES_MAX_LENGTH) {
    throw new Error(
      `Global agent rules must be ${GLOBAL_AGENT_RULES_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  return instructions;
}

export async function readGlobalAgentRulesInTransaction(
  tx: Prisma.TransactionClient,
): Promise<GlobalAgentRulesSnapshot> {
  const row = await tx.agentRuleSet.findUnique({
    where: { scope: GLOBAL_AGENT_RULES_SCOPE },
  });
  return row
    ? {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: row.instructions,
        version: row.version,
        updatedAt: row.updatedAt,
      }
    : {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: "",
        version: 0,
        updatedAt: null,
      };
}

export async function readGlobalAgentRules(): Promise<GlobalAgentRulesSnapshot> {
  const row = await db.agentRuleSet.findUnique({
    where: { scope: GLOBAL_AGENT_RULES_SCOPE },
  });
  return row
    ? {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: row.instructions,
        version: row.version,
        updatedAt: row.updatedAt,
      }
    : {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: "",
        version: 0,
        updatedAt: null,
      };
}

export async function saveGlobalAgentRules(
  value: unknown,
  runTransaction: AgentRulesTransactionRunner = runDefaultTransaction,
): Promise<GlobalAgentRulesSnapshot> {
  const instructions = normalizeGlobalAgentRules(value);
  return runTransaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`LOCK TABLE "AgentRuleSet" IN SHARE ROW EXCLUSIVE MODE`,
    );
    const row = await tx.agentRuleSet.upsert({
      where: { scope: GLOBAL_AGENT_RULES_SCOPE },
      create: {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions,
        version: 1,
      },
      update: {
        instructions,
        version: { increment: 1 },
      },
    });
    return {
      scope: GLOBAL_AGENT_RULES_SCOPE,
      instructions: row.instructions,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  });
}
