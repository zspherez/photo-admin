import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { GLOBAL_AGENT_RULES_MAX_LENGTH } from "@/lib/agentRuleConstants";

export const CONTACT_AUDIT_AGENT_RULES_SCOPE = "contact_audit" as const;

export interface ContactAuditAgentRulesSnapshot {
  scope: typeof CONTACT_AUDIT_AGENT_RULES_SCOPE;
  instructions: string;
  autoAppendAdditionalContact: boolean;
  version: number;
  updatedAt: Date | null;
}

export type ContactAuditAgentRulesTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

const runDefaultTransaction: ContactAuditAgentRulesTransactionRunner = (work) =>
  db.$transaction(work);

export function normalizeContactAuditAgentRules(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Contact audit agent rules must be text.");
  }
  const instructions = value.trim();
  if (instructions.length > GLOBAL_AGENT_RULES_MAX_LENGTH) {
    throw new Error(
      `Contact audit agent rules must be ${GLOBAL_AGENT_RULES_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  return instructions;
}

function snapshotFromRow(row: {
  instructions: string;
  directOutreachRules: Prisma.JsonValue;
  version: number;
  updatedAt: Date;
}): ContactAuditAgentRulesSnapshot {
  return {
    scope: CONTACT_AUDIT_AGENT_RULES_SCOPE,
    instructions: row.instructions,
    autoAppendAdditionalContact:
      Array.isArray(row.directOutreachRules) &&
      row.directOutreachRules.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          Reflect.get(entry, "action") ===
            "auto_append_additional_contact" &&
          Reflect.get(entry, "enabled") === true,
      ),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function emptySnapshot(): ContactAuditAgentRulesSnapshot {
  return {
    scope: CONTACT_AUDIT_AGENT_RULES_SCOPE,
    instructions: "",
    autoAppendAdditionalContact: false,
    version: 0,
    updatedAt: null,
  };
}

export async function readContactAuditAgentRulesInTransaction(
  tx: Prisma.TransactionClient,
): Promise<ContactAuditAgentRulesSnapshot> {
  const row = await tx.agentRuleSet.findUnique({
    where: { scope: CONTACT_AUDIT_AGENT_RULES_SCOPE },
    select: {
      instructions: true,
      directOutreachRules: true,
      version: true,
      updatedAt: true,
    },
  });
  return row ? snapshotFromRow(row) : emptySnapshot();
}

export async function readContactAuditAgentRules(): Promise<ContactAuditAgentRulesSnapshot> {
  const row = await db.agentRuleSet.findUnique({
    where: { scope: CONTACT_AUDIT_AGENT_RULES_SCOPE },
    select: {
      instructions: true,
      directOutreachRules: true,
      version: true,
      updatedAt: true,
    },
  });
  return row ? snapshotFromRow(row) : emptySnapshot();
}

export async function saveContactAuditAgentRules(
  values: {
    instructions: unknown;
    autoAppendAdditionalContact: unknown;
  },
  runTransaction: ContactAuditAgentRulesTransactionRunner = runDefaultTransaction,
): Promise<ContactAuditAgentRulesSnapshot> {
  const instructions = normalizeContactAuditAgentRules(values.instructions);
  if (typeof values.autoAppendAdditionalContact !== "boolean") {
    throw new Error("Auto-append policy must be enabled or disabled.");
  }
  const policy: Prisma.JsonArray = values.autoAppendAdditionalContact
    ? [{ action: "auto_append_additional_contact", enabled: true }]
    : [];
  return runTransaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`LOCK TABLE "AgentRuleSet" IN SHARE ROW EXCLUSIVE MODE`,
    );
    const row = await tx.agentRuleSet.upsert({
      where: { scope: CONTACT_AUDIT_AGENT_RULES_SCOPE },
      create: {
        scope: CONTACT_AUDIT_AGENT_RULES_SCOPE,
        instructions,
        directOutreachRules: policy,
        version: 1,
      },
      update: {
        instructions,
        directOutreachRules: policy,
        version: { increment: 1 },
      },
      select: {
        instructions: true,
        directOutreachRules: true,
        version: true,
        updatedAt: true,
      },
    });
    return snapshotFromRow(row);
  });
}

export function contactAuditAutoAppendAlternativeId(
  jobs: readonly {
    status: string;
    finding: string | null;
    confidence: string | null;
    claimedAutoAppendAdditionalContact: boolean | null;
    rosterReview: Prisma.JsonValue;
    alternatives: readonly {
      id: string;
      normalizedEmail: string;
      confidence: string;
    }[];
  }[],
): string | null {
  if (
    jobs.length === 0 ||
    jobs.some(
      (job) =>
        job.status !== "complete" ||
        job.claimedAutoAppendAdditionalContact !== true ||
        job.confidence !== "high" ||
        (job.finding !== "current" && job.finding !== "changed"),
    )
  ) {
    return null;
  }

  for (const job of jobs) {
    if (!Array.isArray(job.rosterReview) || job.rosterReview.length === 0) {
      return null;
    }
    for (const value of job.rosterReview) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
      ) {
        return null;
      }
      const assessment = Reflect.get(value, "assessment");
      if (assessment !== "current" && assessment !== "coexisting") {
        return null;
      }
    }
  }

  const alternatives = jobs.flatMap((job) => job.alternatives);
  const byEmail = new Map<
    string,
    Array<(typeof alternatives)[number]>
  >();
  for (const alternative of alternatives) {
    const email = alternative.normalizedEmail.toLowerCase();
    const rows = byEmail.get(email) ?? [];
    rows.push(alternative);
    byEmail.set(email, rows);
  }
  if (byEmail.size !== 1) return null;
  const rows = [...byEmail.values()][0];
  if (rows.length === 0 || rows.some((row) => row.confidence !== "high")) {
    return null;
  }
  return rows[0].id;
}
