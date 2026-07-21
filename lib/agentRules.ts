import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  assertNoPhoneLikeNumber,
  normalizeUnicodeDigits,
} from "@/lib/phoneSafety";

export const GLOBAL_AGENT_RULES_SCOPE = "global" as const;
export const GLOBAL_AGENT_RULES_MAX_LENGTH = 8_000;
export const DIRECT_OUTREACH_RULES_MAX_LENGTH = 8_000;
export const DIRECT_OUTREACH_RULE_PREFIX = "DIRECT_OUTREACH ";

export interface DirectOutreachAgentRule {
  id: string;
  action: "direct_outreach";
  managerName: string;
  note: string;
  canonicalRule: string;
}

export interface GlobalAgentRulesSnapshot {
  scope: typeof GLOBAL_AGENT_RULES_SCOPE;
  instructions: string;
  directOutreachRules: DirectOutreachAgentRule[];
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

function normalizedRuleManager(value: string): string {
  return normalizeUnicodeDigits(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalDirectOutreachRule(input: {
  id: string;
  managerName: string;
  note: string;
}): string {
  return `${DIRECT_OUTREACH_RULE_PREFIX}${JSON.stringify({
    id: input.id,
    manager: input.managerName,
    note: input.note,
  })}`;
}

function normalizeDirectOutreachRuleObject(
  value: unknown,
  lineNumber: number,
): DirectOutreachAgentRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Direct outreach rule line ${lineNumber} must contain one JSON object.`,
    );
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "id,manager,note") {
    throw new Error(
      `Direct outreach rule line ${lineNumber} must contain exactly id, manager, and note.`,
    );
  }
  if (typeof input.id !== "string") {
    throw new Error(`Direct outreach rule line ${lineNumber} needs an id.`);
  }
  const id = input.id.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error(
      `Direct outreach rule line ${lineNumber} id must be 2-64 lowercase letters, numbers, hyphens, or underscores.`,
    );
  }
  if (typeof input.manager !== "string") {
    throw new Error(
      `Direct outreach rule line ${lineNumber} needs a manager name.`,
    );
  }
  const managerName = input.manager.trim();
  if (
    managerName.length < 2 ||
    managerName.length > 200 ||
    normalizedRuleManager(managerName).length < 2
  ) {
    throw new Error(
      `Direct outreach rule line ${lineNumber} manager must identify one named manager.`,
    );
  }
  if (typeof input.note !== "string") {
    throw new Error(`Direct outreach rule line ${lineNumber} needs a note.`);
  }
  const note = input.note.trim();
  if (!note || note.length > 900) {
    throw new Error(
      `Direct outreach rule line ${lineNumber} note must be 1-900 characters.`,
    );
  }
  assertNoPhoneLikeNumber(id, `Direct outreach rule line ${lineNumber} id`);
  assertNoPhoneLikeNumber(
    managerName,
    `Direct outreach rule line ${lineNumber} manager`,
  );
  assertNoPhoneLikeNumber(
    note,
    `Direct outreach rule line ${lineNumber} note`,
  );
  return {
    id,
    action: "direct_outreach",
    managerName,
    note,
    canonicalRule: canonicalDirectOutreachRule({
      id,
      managerName,
      note,
    }),
  };
}

export function parseDirectOutreachAgentRules(
  value: unknown,
): DirectOutreachAgentRule[] {
  if (typeof value !== "string") {
    throw new Error("Direct outreach rules must be text.");
  }
  const source = value.trim();
  if (source.length > DIRECT_OUTREACH_RULES_MAX_LENGTH) {
    throw new Error(
      `Direct outreach rules must be ${DIRECT_OUTREACH_RULES_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  if (!source) return [];
  const rules = source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith(DIRECT_OUTREACH_RULE_PREFIX)) {
      throw new Error(
        `Direct outreach rule line ${index + 1} must start with ${DIRECT_OUTREACH_RULE_PREFIX.trim()}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(DIRECT_OUTREACH_RULE_PREFIX.length));
    } catch {
      throw new Error(
        `Direct outreach rule line ${index + 1} contains invalid JSON.`,
      );
    }
    return [normalizeDirectOutreachRuleObject(parsed, index + 1)];
  });
  const ids = new Set<string>();
  const managers = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new Error(`Direct outreach rule id ${rule.id} is duplicated.`);
    }
    const manager = normalizedRuleManager(rule.managerName);
    if (managers.has(manager)) {
      throw new Error(
        `Direct outreach manager ${rule.managerName} has more than one rule.`,
      );
    }
    ids.add(rule.id);
    managers.add(manager);
  }
  return rules;
}

export function serializeDirectOutreachAgentRules(
  rules: readonly DirectOutreachAgentRule[],
): string {
  return rules.map((rule) => rule.canonicalRule).join("\n");
}

export function readStoredDirectOutreachAgentRules(
  value: Prisma.JsonValue,
): DirectOutreachAgentRule[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored direct outreach rules are invalid.");
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error("Stored direct outreach rules are invalid.");
    }
    const input = entry as Record<string, unknown>;
    const canonicalRule =
      typeof input.canonicalRule === "string" ? input.canonicalRule : "";
    if (!canonicalRule.startsWith(DIRECT_OUTREACH_RULE_PREFIX)) {
      throw new Error("Stored direct outreach rules are invalid.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        canonicalRule.slice(DIRECT_OUTREACH_RULE_PREFIX.length),
      );
    } catch {
      throw new Error("Stored direct outreach rules are invalid.");
    }
    const normalized = normalizeDirectOutreachRuleObject(parsed, index + 1);
    if (
      input.id !== normalized.id ||
      input.action !== normalized.action ||
      input.managerName !== normalized.managerName ||
      input.note !== normalized.note ||
      canonicalRule !== normalized.canonicalRule
    ) {
      throw new Error("Stored direct outreach rules are invalid.");
    }
    return normalized;
  });
}

function snapshotFromRow(row: {
  instructions: string;
  directOutreachRules: Prisma.JsonValue;
  version: number;
  updatedAt: Date;
}): GlobalAgentRulesSnapshot {
  return {
    scope: GLOBAL_AGENT_RULES_SCOPE,
    instructions: row.instructions,
    directOutreachRules: readStoredDirectOutreachAgentRules(
      row.directOutreachRules,
    ),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export async function readGlobalAgentRulesInTransaction(
  tx: Prisma.TransactionClient,
): Promise<GlobalAgentRulesSnapshot> {
  const row = await tx.agentRuleSet.findUnique({
    where: { scope: GLOBAL_AGENT_RULES_SCOPE },
  });
  return row
    ? snapshotFromRow(row)
    : {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: "",
        directOutreachRules: [],
        version: 0,
        updatedAt: null,
      };
}

export async function readGlobalAgentRules(): Promise<GlobalAgentRulesSnapshot> {
  const row = await db.agentRuleSet.findUnique({
    where: { scope: GLOBAL_AGENT_RULES_SCOPE },
  });
  return row
    ? snapshotFromRow(row)
    : {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions: "",
        directOutreachRules: [],
        version: 0,
        updatedAt: null,
      };
}

export async function saveGlobalAgentRuleSet(
  values: {
    instructions: unknown;
    directOutreachRules?: unknown;
  },
  runTransaction: AgentRulesTransactionRunner = runDefaultTransaction,
): Promise<GlobalAgentRulesSnapshot> {
  const instructions = normalizeGlobalAgentRules(values.instructions);
  const directOutreachRules =
    values.directOutreachRules === undefined
      ? undefined
      : parseDirectOutreachAgentRules(values.directOutreachRules);
  return runTransaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`LOCK TABLE "AgentRuleSet" IN SHARE ROW EXCLUSIVE MODE`,
    );
    const row = await tx.agentRuleSet.upsert({
      where: { scope: GLOBAL_AGENT_RULES_SCOPE },
      create: {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions,
        directOutreachRules: (directOutreachRules ??
          []) as unknown as Prisma.InputJsonValue,
        version: 1,
      },
      update: {
        instructions,
        ...(directOutreachRules !== undefined
          ? {
              directOutreachRules:
                directOutreachRules as unknown as Prisma.InputJsonValue,
            }
          : {}),
        version: { increment: 1 },
      },
    });
    return snapshotFromRow(row);
  });
}

export async function saveGlobalAgentRules(
  value: unknown,
  runTransaction: AgentRulesTransactionRunner = runDefaultTransaction,
): Promise<GlobalAgentRulesSnapshot> {
  return saveGlobalAgentRuleSet({ instructions: value }, runTransaction);
}
