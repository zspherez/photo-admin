import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { normalizeEmail } from "@/lib/resend";

export const LEGACY_CONTACT_SNAPSHOT_HEADERS = [
  "snapshot_timestamp",
  "snapshot_id",
  "contact_id",
  "artist_id",
  "artist_name",
  "contact_state",
  "name",
  "role",
  "email",
  "phone",
  "direct_outreach_note",
  "full_team",
  "custom_price",
  "notes",
  "source",
  "source_key",
  "source_sync_timestamp",
  "created_at",
  "updated_at",
] as const;

export const CONTACT_SNAPSHOT_HEADERS = [
  "artist_name",
  "name",
  "role",
  "email",
  "phone",
  "direct_outreach",
  "source",
  "created_at",
  "updated_at",
  "snapshot_timestamp",
  "snapshot_id",
  "contact_id",
  "artist_id",
  "contact_state",
  "custom_price",
  "notes",
  "source_key",
  "source_sync_timestamp",
  "research_confidence",
  "research_evidence",
  "research_source_urls",
  "audit_finding",
  "audit_confidence",
  "audit_evidence",
  "audit_source_urls",
  "audit_verified_at",
] as const;

export const CONTACT_SNAPSHOT_VISIBLE_HEADERS = [
  "artist_name",
  "name",
  "role",
  "email",
  "phone",
  "direct_outreach",
  "source",
  "created_at",
  "updated_at",
] as const;

export const CONTACT_SNAPSHOT_MAX_CONTACTS = 100_000;
export const GOOGLE_SHEET_MAX_CELL_CHARACTERS = 50_000;

export type ContactSnapshotCell = string | boolean | null;
export type ContactSnapshotRow = ContactSnapshotCell[];

export interface ContactSnapshotSourceRow {
  id: string;
  artistId: string;
  state: "active" | "quarantined";
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
  isFullTeam?: boolean;
  customPrice: string | null;
  notes: string | null;
  source: string | null;
  sourceKey: string | null;
  sourceSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  researchConfidence?: string | null;
  researchEvidence?: string | null;
  researchSourceUrls?: string[];
  auditFinding?: string | null;
  auditConfidence?: string | null;
  auditEvidence?: string | null;
  auditSourceUrls?: string[];
  auditVerifiedAt?: Date | null;
  artist: {
    id: string;
    name: string;
    normalizedName: string;
  };
}

export interface CanonicalContactSnapshot {
  id: string;
  timestamp: Date;
  formatVersion: 1 | 2;
  headers: readonly string[];
  rows: ContactSnapshotRow[];
  contactCount: number;
  contentSha256: string;
}

export type ContactSnapshotTransaction = Pick<
  Prisma.TransactionClient,
  "contact" | "contactResearchCandidate" | "$queryRaw"
>;

export class ContactSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactSnapshotValidationError";
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSourceRows(
  left: ContactSnapshotSourceRow,
  right: ContactSnapshotSourceRow,
): number {
  return (
    compareText(left.artist.normalizedName, right.artist.normalizedName) ||
    compareText(left.artistId, right.artistId) ||
    compareText(left.state, right.state) ||
    compareText(left.id, right.id)
  );
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function assertBoundedRows(
  rows: readonly ContactSnapshotRow[],
  headers: readonly string[] = CONTACT_SNAPSHOT_HEADERS,
): void {
  if (rows.length > CONTACT_SNAPSHOT_MAX_CONTACTS) {
    throw new ContactSnapshotValidationError(
      `Contact snapshot exceeds the ${CONTACT_SNAPSHOT_MAX_CONTACTS.toLocaleString()} row limit`,
    );
  }
  for (const [rowIndex, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new ContactSnapshotValidationError(
        `Contact snapshot row ${rowIndex + 1} has an invalid column count`,
      );
    }
    for (const [columnIndex, value] of row.entries()) {
      if (
        typeof value === "string" &&
        value.length > GOOGLE_SHEET_MAX_CELL_CHARACTERS
      ) {
        throw new ContactSnapshotValidationError(
          `Contact snapshot cell ${headers[columnIndex]} at row ${rowIndex + 1} exceeds the Google Sheets character limit`,
        );
      }
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "boolean"
      ) {
        throw new ContactSnapshotValidationError(
          `Contact snapshot row ${rowIndex + 1} contains an invalid cell value`,
        );
      }
    }
  }
}

export function canonicalContactSnapshotSerialization(
  rows: readonly ContactSnapshotRow[],
  headers: readonly string[] = CONTACT_SNAPSHOT_HEADERS,
  formatVersion: 1 | 2 = 2,
): string {
  assertBoundedRows(rows, headers);
  return formatVersion === 1
    ? JSON.stringify(rows)
    : JSON.stringify({ formatVersion, headers, rows });
}

export function contactSnapshotDigest(
  rows: readonly ContactSnapshotRow[],
  headers: readonly string[] = CONTACT_SNAPSHOT_HEADERS,
  formatVersion: 1 | 2 = 2,
): string {
  return createHash("sha256")
    .update(
      canonicalContactSnapshotSerialization(rows, headers, formatVersion),
      "utf8",
    )
    .digest("hex");
}

export function buildContactSnapshot(
  sourceRows: readonly ContactSnapshotSourceRow[],
  metadata: { id: string; timestamp: Date },
): CanonicalContactSnapshot {
  if (!metadata.id.trim()) {
    throw new ContactSnapshotValidationError("Contact snapshot ID is required");
  }
  if (!Number.isFinite(metadata.timestamp.getTime())) {
    throw new ContactSnapshotValidationError(
      "Contact snapshot timestamp is invalid",
    );
  }

  const timestamp = metadata.timestamp.toISOString();
  const rows = [...sourceRows].sort(compareSourceRows).map((contact) => [
    contact.artist.name,
    contact.name,
    contact.role,
    contact.email,
    contact.phone,
    contact.directOutreachNote,
    contact.source,
    contact.createdAt.toISOString(),
    contact.updatedAt.toISOString(),
    timestamp,
    metadata.id,
    contact.id,
    contact.artistId,
    contact.state,
    contact.customPrice,
    contact.notes,
    contact.sourceKey,
    iso(contact.sourceSyncedAt),
    contact.researchConfidence ?? null,
    contact.researchEvidence ?? null,
    contact.researchSourceUrls?.join("\n") || null,
    contact.auditFinding ?? null,
    contact.auditConfidence ?? null,
    contact.auditEvidence ?? null,
    contact.auditSourceUrls?.join("\n") || null,
    iso(contact.auditVerifiedAt ?? null),
  ]);
  assertBoundedRows(rows);

  return {
    id: metadata.id,
    timestamp: metadata.timestamp,
    formatVersion: 2,
    headers: CONTACT_SNAPSHOT_HEADERS,
    rows,
    contactCount: rows.length,
    contentSha256: contactSnapshotDigest(
      rows,
      CONTACT_SNAPSHOT_HEADERS,
      2,
    ),
  };
}

export function parseStoredContactSnapshotRows(
  value: Prisma.JsonValue,
  headers: readonly string[] = CONTACT_SNAPSHOT_HEADERS,
): ContactSnapshotRow[] {
  if (!Array.isArray(value)) {
    throw new ContactSnapshotValidationError(
      "Stored contact snapshot rows are invalid",
    );
  }
  const rows = value.map((row) => {
    if (!Array.isArray(row)) {
      throw new ContactSnapshotValidationError(
        "Stored contact snapshot rows are invalid",
      );
    }
    return row.map((cell) => {
      if (
        cell === null ||
        typeof cell === "string" ||
        typeof cell === "boolean"
      ) {
        return cell;
      }
      throw new ContactSnapshotValidationError(
        "Stored contact snapshot cell is invalid",
      );
    });
  });
  assertBoundedRows(rows, headers);
  return rows;
}

export function parseStoredContactSnapshotHeaders(
  value: Prisma.JsonValue,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (header) =>
        typeof header !== "string" ||
        !header ||
        header.length > 200,
    )
  ) {
    throw new ContactSnapshotValidationError(
      "Stored contact snapshot headers are invalid",
    );
  }
  return value as string[];
}

export function escapeGoogleSheetCell(
  value: ContactSnapshotCell,
): ContactSnapshotCell {
  return typeof value === "string" && /^[=+\-@]/.test(value)
    ? `'${value}`
    : value;
}

export function contactSnapshotGoogleRows(
  rows: readonly ContactSnapshotRow[],
  headers: readonly string[] = CONTACT_SNAPSHOT_HEADERS,
): ContactSnapshotRow[] {
  assertBoundedRows(rows, headers);
  return rows.map((row) => row.map(escapeGoogleSheetCell));
}

export async function readCanonicalContactRows(
  tx: ContactSnapshotTransaction,
): Promise<ContactSnapshotSourceRow[]> {
  const contacts = await tx.contact.findMany({
    where: {
      state: {
        in: ["active", "quarantined"],
      },
    },
    select: {
      id: true,
      artistId: true,
      state: true,
      name: true,
      role: true,
      email: true,
      phone: true,
      directOutreachNote: true,
      customPrice: true,
      notes: true,
      source: true,
      sourceKey: true,
      sourceSyncedAt: true,
      createdAt: true,
      updatedAt: true,
      artist: {
        select: {
          id: true,
          name: true,
          normalizedName: true,
        },
      },
    },
  });
  const artistIds = Array.from(new Set(contacts.map((contact) => contact.artistId)));
  const contactIds = contacts.map((contact) => contact.id);
  const [researchCandidates, auditJobs] = await Promise.all([
    artistIds.length === 0
      ? Promise.resolve([])
      : tx.contactResearchCandidate.findMany({
          where: {
            status: "approved",
            job: { artistId: { in: artistIds } },
          },
          orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }],
          select: {
            normalizedEmail: true,
            confidence: true,
            evidence: true,
            sourceUrls: true,
            job: { select: { artistId: true } },
          },
        }),
    contactIds.length === 0
      ? Promise.resolve([])
      : tx.$queryRaw<
          Array<{
            contactId: string | null;
            resolvedContactId: string | null;
            finding: string | null;
            confidence: string | null;
            evidence: string | null;
            sourceUrls: string[];
            verifiedAt: Date;
          }>
        >(Prisma.sql`
          SELECT DISTINCT ON (
            COALESCE(audit_job."resolvedContactId", audit_job."contactId")
          )
            audit_job."contactId",
            audit_job."resolvedContactId",
            audit_job."finding",
            audit_job."confidence",
            audit_job."evidence",
            audit_job."sourceUrls",
            audit_job."verifiedAt"
          FROM "ContactAuditJob" AS audit_job
          WHERE audit_job."verifiedAt" IS NOT NULL
            AND (
              audit_job."resolvedContactId" = ANY(${contactIds}::text[])
              OR (
                audit_job."resolvedContactId" IS NULL
                AND audit_job."contactId" = ANY(${contactIds}::text[])
              )
            )
          ORDER BY
            COALESCE(
              audit_job."resolvedContactId",
              audit_job."contactId"
            ),
            audit_job."verifiedAt" DESC,
            audit_job."createdAt" DESC
        `),
  ]);
  const researchByContact = new Map<
    string,
    (typeof researchCandidates)[number]
  >();
  const contactByArtistEmail = new Map(
    contacts.flatMap((contact) => {
      const email = normalizeEmail(contact.email ?? "");
      return email ? [[`${contact.artistId}\u0000${email}`, contact] as const] : [];
    }),
  );
  for (const candidate of researchCandidates) {
    const contact = contactByArtistEmail.get(
      `${candidate.job.artistId}\u0000${candidate.normalizedEmail}`,
    );
    if (contact && !researchByContact.has(contact.id)) {
      researchByContact.set(contact.id, candidate);
    }
  }
  const auditByContact = new Map<string, (typeof auditJobs)[number]>();
  for (const audit of auditJobs) {
    const contactId = audit.resolvedContactId ?? audit.contactId;
    if (contactId && !auditByContact.has(contactId)) {
      auditByContact.set(contactId, audit);
    }
  }
  return contacts.map((contact) => {
    const research = researchByContact.get(contact.id);
    const audit = auditByContact.get(contact.id);
    return {
      ...contact,
      researchConfidence: research?.confidence ?? null,
      researchEvidence: research?.evidence ?? null,
      researchSourceUrls: research?.sourceUrls ?? [],
      auditFinding: audit?.finding ?? null,
      auditConfidence: audit?.confidence ?? null,
      auditEvidence: audit?.evidence ?? null,
      auditSourceUrls: audit?.sourceUrls ?? [],
      auditVerifiedAt: audit?.verifiedAt ?? null,
    };
  });
}
