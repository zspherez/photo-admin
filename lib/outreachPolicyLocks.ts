import { Prisma } from "@prisma/client";
import { normalizeEmails } from "@/lib/resend";

export const OUTREACH_RECIPIENT_POLICY_LOCK_CLASS = 1_330_072_011;

export function outreachRecipientPolicyLockEmails(
  values: readonly string[],
): string[] {
  return normalizeEmails([...values]);
}

export async function acquireOutreachRecipientPolicyLocks(
  tx: Prisma.TransactionClient,
  values: readonly string[],
): Promise<void> {
  for (const email of outreachRecipientPolicyLockEmails(values)) {
    await tx.$queryRaw<Array<{ locked: number }>>(
      Prisma.sql`
        SELECT 1 AS "locked"
        FROM (
          SELECT pg_advisory_xact_lock(
            ${OUTREACH_RECIPIENT_POLICY_LOCK_CLASS},
            hashtext(${email})
          )
        ) AS "outreachRecipientPolicyLock"
      `,
    );
  }
}
