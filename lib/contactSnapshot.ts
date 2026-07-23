import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const CONTACT_SNAPSHOT_HEADERS = [
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
  isFullTeam: boolean;
  customPrice: string | null;
  notes: string | null;
  source: string | null;
  sourceKey: string | null;
  sourceSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  artist: {
    id: string;
    name: string;
    normalizedName: string;
  };
}

export interface CanonicalContactSnapshot {
  id: string;
  timestamp: Date;
  headers: readonly string[];
  rows: ContactSnapshotRow[];
  contactCount: number;
  contentSha256: string;
}

export type ContactSnapshotTransaction = Pick<
  Prisma.TransactionClient,
  "contact"
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

function assertBoundedRows(rows: readonly ContactSnapshotRow[]): void {
  if (rows.length > CONTACT_SNAPSHOT_MAX_CONTACTS) {
    throw new ContactSnapshotValidationError(
      `Contact snapshot exceeds the ${CONTACT_SNAPSHOT_MAX_CONTACTS.toLocaleString()} row limit`,
    );
  }
  for (const [rowIndex, row] of rows.entries()) {
    if (row.length !== CONTACT_SNAPSHOT_HEADERS.length) {
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
          `Contact snapshot cell ${CONTACT_SNAPSHOT_HEADERS[columnIndex]} at row ${rowIndex + 1} exceeds the Google Sheets character limit`,
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
): string {
  assertBoundedRows(rows);
  return JSON.stringify(rows);
}

export function contactSnapshotDigest(
  rows: readonly ContactSnapshotRow[],
): string {
  return createHash("sha256")
    .update(canonicalContactSnapshotSerialization(rows), "utf8")
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
    timestamp,
    metadata.id,
    contact.id,
    contact.artistId,
    contact.artist.name,
    contact.state,
    contact.name,
    contact.role,
    contact.email,
    contact.phone,
    contact.directOutreachNote,
    contact.isFullTeam,
    contact.customPrice,
    contact.notes,
    contact.source,
    contact.sourceKey,
    iso(contact.sourceSyncedAt),
    contact.createdAt.toISOString(),
    contact.updatedAt.toISOString(),
  ]);
  assertBoundedRows(rows);

  return {
    id: metadata.id,
    timestamp: metadata.timestamp,
    headers: CONTACT_SNAPSHOT_HEADERS,
    rows,
    contactCount: rows.length,
    contentSha256: contactSnapshotDigest(rows),
  };
}

export function parseStoredContactSnapshotRows(
  value: Prisma.JsonValue,
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
  assertBoundedRows(rows);
  return rows;
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
): ContactSnapshotRow[] {
  assertBoundedRows(rows);
  return rows.map((row) => row.map(escapeGoogleSheetCell));
}

export async function readCanonicalContactRows(
  tx: ContactSnapshotTransaction,
): Promise<ContactSnapshotSourceRow[]> {
  return tx.contact.findMany({
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
      isFullTeam: true,
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
}
