import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { assertNoPhoneLikeNumber } from "@/lib/phoneSafety";
import {
  DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH,
  GLOBAL_AGENT_RULES_MAX_LENGTH,
} from "@/lib/agentRuleConstants";
import {
  DIRECT_OUTREACH_RULE_PREFIX,
} from "@/lib/directOutreachInstruction";

export const GLOBAL_AGENT_RULES_SCOPE = "global" as const;
export {
  DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH,
  GLOBAL_AGENT_RULES_MAX_LENGTH,
} from "@/lib/agentRuleConstants";
export {
  canonicalDirectOutreachInstructionExcerpt,
  directOutreachInstructionExcerptFromCanonical,
  DIRECT_OUTREACH_RULE_PREFIX,
} from "@/lib/directOutreachInstruction";

const DIRECT_OUTREACH_INSTRUCTIONS_ACTION =
  "direct_outreach_instructions" as const;

interface LegacyDirectOutreachRule {
  id: string;
  managerName: string;
  note: string;
}

export interface GlobalAgentRulesSnapshot {
  scope: typeof GLOBAL_AGENT_RULES_SCOPE;
  instructions: string;
  directOutreachInstructions: string;
  version: number;
  updatedAt: Date | null;
}

export interface GlobalAgentRulesEditorSnapshot
  extends GlobalAgentRulesSnapshot {
  directOutreachStorageError: string | null;
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

function looksLikeStructuredRuleSyntax(value: string): boolean {
  return value
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return (
        /^DIRECT_OUTREACH\b/i.test(trimmed) ||
        trimmed.startsWith("{") ||
        trimmed.startsWith("[")
      );
    });
}

export function normalizeDirectOutreachInstructions(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Direct outreach rules must be plain-language text.");
  }
  const instructions = value.trim();
  if (instructions.length > DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH) {
    throw new Error(
      `Direct outreach rules must be ${DIRECT_OUTREACH_INSTRUCTIONS_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  if (looksLikeStructuredRuleSyntax(instructions)) {
    throw new Error(
      "Direct outreach rules must use plain-language sentences.",
    );
  }
  assertNoPhoneLikeNumber(instructions, "Direct outreach rules");
  return instructions;
}

function normalizeLegacyRuleObject(
  value: unknown,
  position: number,
): LegacyDirectOutreachRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Stored direct outreach rule ${position} is invalid.`);
  }
  const input = value as Record<string, unknown>;
  const canonicalRule =
    typeof input.canonicalRule === "string" ? input.canonicalRule : null;
  if (canonicalRule) {
    if (!canonicalRule.startsWith(DIRECT_OUTREACH_RULE_PREFIX)) {
      throw new Error(`Stored direct outreach rule ${position} is invalid.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        canonicalRule.slice(DIRECT_OUTREACH_RULE_PREFIX.length),
      );
    } catch {
      throw new Error(`Stored direct outreach rule ${position} is invalid.`);
    }
    return normalizeLegacyRuleObject(parsed, position);
  }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const managerValue =
    typeof input.manager === "string" ? input.manager : input.managerName;
  const managerName =
    typeof managerValue === "string" ? managerValue.trim() : "";
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id) ||
    managerName.length < 2 ||
    managerName.length > 200 ||
    !note ||
    note.length > 900
  ) {
    throw new Error(`Stored direct outreach rule ${position} is invalid.`);
  }
  assertNoPhoneLikeNumber(managerName, "Stored direct outreach manager");
  assertNoPhoneLikeNumber(note, "Stored direct outreach note");
  return { id, managerName, note };
}

function parseLegacyRuleLine(
  value: string,
  position: number,
): LegacyDirectOutreachRule {
  const trimmed = value.trim();
  if (!trimmed.startsWith(DIRECT_OUTREACH_RULE_PREFIX)) {
    throw new Error(`Stored direct outreach rule ${position} is invalid.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(DIRECT_OUTREACH_RULE_PREFIX.length));
  } catch {
    throw new Error(`Stored direct outreach rule ${position} is invalid.`);
  }
  return normalizeLegacyRuleObject(parsed, position);
}

function legacyRuleToPlainLanguage(rule: LegacyDirectOutreachRule): string {
  const note = /[.!?]$/.test(rule.note) ? rule.note : `${rule.note}.`;
  return `When an artist is managed by ${rule.managerName}, add this direct outreach note: ${note}`;
}

function parseStoredDirectOutreachInstructions(
  value: Prisma.JsonValue,
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (!trimmed.startsWith(DIRECT_OUTREACH_RULE_PREFIX)) {
      return normalizeDirectOutreachInstructions(trimmed);
    }
    return normalizeDirectOutreachInstructions(
      trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) =>
          legacyRuleToPlainLanguage(parseLegacyRuleLine(line, index + 1)),
        )
        .join("\n"),
    );
  }
  if (!Array.isArray(value)) {
    throw new Error("Stored direct outreach rules are invalid.");
  }
  if (value.length === 0) return "";
  if (value.length === 1) {
    const entry = value[0];
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      const input = entry as Record<string, unknown>;
      if (
        input.action === DIRECT_OUTREACH_INSTRUCTIONS_ACTION &&
        typeof input.instructions === "string" &&
        Object.keys(input).sort().join(",") === "action,instructions"
      ) {
        return normalizeDirectOutreachInstructions(input.instructions);
      }
    }
  }
  return normalizeDirectOutreachInstructions(
    value
      .map((entry, index) => {
        const rule =
          typeof entry === "string"
            ? parseLegacyRuleLine(entry, index + 1)
            : normalizeLegacyRuleObject(entry, index + 1);
        return legacyRuleToPlainLanguage(rule);
      })
      .join("\n"),
  );
}

export function readStoredDirectOutreachInstructions(
  value: Prisma.JsonValue,
): string {
  return parseStoredDirectOutreachInstructions(value);
}

export function directOutreachInstructionsStorage(
  instructions: string,
): Prisma.JsonArray {
  return instructions
    ? [
        {
          action: DIRECT_OUTREACH_INSTRUCTIONS_ACTION,
          instructions,
        },
      ]
    : [];
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
    directOutreachInstructions: readStoredDirectOutreachInstructions(
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
        directOutreachInstructions: "",
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
        directOutreachInstructions: "",
        version: 0,
        updatedAt: null,
      };
}

export async function readGlobalAgentRulesForEditing(): Promise<GlobalAgentRulesEditorSnapshot> {
  const row = await db.agentRuleSet.findUnique({
    where: { scope: GLOBAL_AGENT_RULES_SCOPE },
  });
  if (!row) {
    return {
      scope: GLOBAL_AGENT_RULES_SCOPE,
      instructions: "",
      directOutreachInstructions: "",
      directOutreachStorageError: null,
      version: 0,
      updatedAt: null,
    };
  }
  try {
    return {
      ...snapshotFromRow(row),
      directOutreachStorageError: null,
    };
  } catch {
    return {
      scope: GLOBAL_AGENT_RULES_SCOPE,
      instructions: row.instructions,
      directOutreachInstructions: "",
      directOutreachStorageError:
        "Stored legacy direct outreach rules could not be converted. Replace them with plain-language instructions and save.",
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }
}

export async function saveGlobalAgentRuleSet(
  values: {
    instructions: unknown;
    directOutreachInstructions?: unknown;
  },
  runTransaction: AgentRulesTransactionRunner = runDefaultTransaction,
): Promise<GlobalAgentRulesSnapshot> {
  const instructions = normalizeGlobalAgentRules(values.instructions);
  const directOutreachInstructions =
    values.directOutreachInstructions === undefined
      ? undefined
      : normalizeDirectOutreachInstructions(
          values.directOutreachInstructions,
        );
  return runTransaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`LOCK TABLE "AgentRuleSet" IN SHARE ROW EXCLUSIVE MODE`,
    );
    const row = await tx.agentRuleSet.upsert({
      where: { scope: GLOBAL_AGENT_RULES_SCOPE },
      create: {
        scope: GLOBAL_AGENT_RULES_SCOPE,
        instructions,
        directOutreachRules: directOutreachInstructionsStorage(
          directOutreachInstructions ?? "",
        ),
        version: 1,
      },
      update: {
        instructions,
        ...(directOutreachInstructions !== undefined
          ? {
              directOutreachRules: directOutreachInstructionsStorage(
                directOutreachInstructions,
              ),
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
