import { Prisma } from "@prisma/client";

export function normalizeDirectOutreachContactNote(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/g, " ");
}

export async function findMatchingDirectOutreachContact(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: {
    artistId: string;
    directOutreachNote: string;
    excludeContactId?: string;
  },
): Promise<{ id: string; state: "active" | "quarantined" } | null> {
  const normalizedNote = normalizeDirectOutreachContactNote(
    input.directOutreachNote,
  );
  if (!normalizedNote) return null;
  const excludeClause = input.excludeContactId
    ? Prisma.sql`AND contact."id" <> ${input.excludeContactId}`
    : Prisma.empty;
  const matches = await tx.$queryRaw<
    Array<{ id: string; state: "active" | "quarantined" }>
  >(Prisma.sql`
    SELECT
      contact."id",
      contact."state"::text AS "state"
    FROM "Contact" AS contact
    WHERE contact."artistId" = ${input.artistId}
      AND contact."email" IS NULL
      AND contact."directOutreachNote" IS NOT NULL
      AND "normalize_direct_outreach_contact_note"(
        contact."directOutreachNote"
      ) = "normalize_direct_outreach_contact_note"(
        ${input.directOutreachNote}
      )
      ${excludeClause}
    ORDER BY
      CASE WHEN contact."state" = 'active' THEN 0 ELSE 1 END,
      contact."updatedAt" DESC,
      contact."id" ASC
    LIMIT 1
  `);
  return matches[0] ?? null;
}
