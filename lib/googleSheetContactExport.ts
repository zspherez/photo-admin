import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { sheets_v4 } from "googleapis";
import { db } from "@/lib/db";
import {
  buildContactSnapshot,
  CONTACT_SNAPSHOT_HEADERS,
  contactSnapshotDigest,
  contactSnapshotGoogleRows,
  parseStoredContactSnapshotRows,
  readCanonicalContactRows,
  type CanonicalContactSnapshot,
  type ContactSnapshotRow,
} from "@/lib/contactSnapshot";
import {
  getGoogleSheetsClient,
  hasGoogleSheetsCredentials,
} from "@/lib/googleSheets";
import {
  makeIntegrationSyncLeaseKey,
  withIntegrationSyncLease,
  type IntegrationSyncLeaseGuard,
} from "@/lib/integrationUtils";

const EXPORT_PROVIDER = "google_sheets";
const EXPORT_WRITE_BATCH_ROWS = 250;
const EXPORT_LEASE_WAIT_MS = 2_000;
const MAX_ERROR_LENGTH = 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const CONTACT_EXPORT_SPREADSHEET_SETTING_KEY =
  "google_contact_export_spreadsheet_id";

type ContactExportStatus = "pending" | "writing" | "complete" | "failed";

interface ContactExportSnapshotRecord {
  id: string;
  provider: string;
  status: ContactExportStatus;
  idempotencyKey: string;
  contactCount: number;
  contentSha256: string;
  spreadsheetId: string;
  sheetTabId: number | null;
  sheetTabName: string;
  sheetUrl: string | null;
  requestedByRole: string;
  canonicalRows: Prisma.JsonValue;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactExportSummary {
  id: string;
  status: "complete";
  contactCount: number;
  contentSha256: string;
  spreadsheetId: string;
  sheetTabId: number;
  sheetTabName: string;
  sheetUrl: string;
  startedAt: Date;
  completedAt: Date;
}

export interface ExportGoogleContactSnapshotInput {
  idempotencyKey: string;
  requestedByRole: "admin";
  spreadsheetId?: string;
}

export interface GoogleContactExportDependencies {
  now?: () => Date;
  randomId?: () => string;
  sheetsClient?: sheets_v4.Sheets;
}

export class ContactExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactExportError";
  }
}

export class ContactExportBusyError extends ContactExportError {
  constructor() {
    super("A contact snapshot export with this idempotency key is in progress");
    this.name = "ContactExportBusyError";
  }
}

function assertIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new ContactExportError("Invalid contact export idempotency key");
  }
  return normalized;
}

export function googleContactExportSpreadsheetId(
  value: string | undefined,
): string {
  const normalized = value?.trim() ?? "";
  if (!SPREADSHEET_ID_PATTERN.test(normalized)) {
    throw new ContactExportError(
      "GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID is not configured",
    );
  }
  return normalized;
}

export interface ContactExportSettingStore {
  setting: {
    findUnique(args: {
      where: { key: string };
      select: { value: true };
    }): Promise<{ value: string } | null>;
  };
}

export async function resolveGoogleContactExportSpreadsheetId(
  value: string | undefined = process.env
    .GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID,
  store: ContactExportSettingStore = db,
): Promise<string> {
  if (SPREADSHEET_ID_PATTERN.test(value?.trim() ?? "")) {
    return value!.trim();
  }
  const setting = await store.setting.findUnique({
    where: { key: CONTACT_EXPORT_SPREADSHEET_SETTING_KEY },
    select: { value: true },
  });
  return googleContactExportSpreadsheetId(setting?.value);
}

export async function hasGoogleContactExportConfiguration(): Promise<boolean> {
  const hasCredentials = hasGoogleSheetsCredentials();
  try {
    await resolveGoogleContactExportSpreadsheetId();
    return hasCredentials;
  } catch {
    return false;
  }
}

function tabTimestamp(timestamp: Date): string {
  const iso = timestamp.toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(":", "")}`;
}

export function contactSnapshotTabName(
  timestamp: Date,
  snapshotId: string,
): string {
  return `contacts_${tabTimestamp(timestamp)}_${snapshotId}`;
}

function quoteSheetTitle(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

function spreadsheetUrl(spreadsheetId: string, sheetTabId: number): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
    spreadsheetId,
  )}/edit#gid=${sheetTabId}`;
}

function completedSummary(
  record: ContactExportSnapshotRecord,
): ContactExportSummary {
  if (
    record.status !== "complete" ||
    record.sheetTabId === null ||
    record.sheetUrl === null ||
    record.completedAt === null
  ) {
    throw new ContactExportError(
      "Completed contact export metadata is incomplete",
    );
  }
  return {
    id: record.id,
    status: "complete",
    contactCount: record.contactCount,
    contentSha256: record.contentSha256,
    spreadsheetId: record.spreadsheetId,
    sheetTabId: record.sheetTabId,
    sheetTabName: record.sheetTabName,
    sheetUrl: record.sheetUrl,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function snapshotFromRecord(
  record: ContactExportSnapshotRecord,
): CanonicalContactSnapshot {
  const rows = parseStoredContactSnapshotRows(record.canonicalRows);
  if (
    rows.length !== record.contactCount ||
    contactSnapshotDigest(rows) !== record.contentSha256
  ) {
    throw new ContactExportError(
      "Stored contact snapshot content failed integrity verification",
    );
  }
  const timestamp = record.startedAt.toISOString();
  for (const row of rows) {
    if (row[0] !== timestamp || row[1] !== record.id) {
      throw new ContactExportError(
        "Stored contact snapshot metadata failed integrity verification",
      );
    }
  }
  return {
    id: record.id,
    timestamp: record.startedAt,
    headers: CONTACT_SNAPSHOT_HEADERS,
    rows,
    contactCount: record.contactCount,
    contentSha256: record.contentSha256,
  };
}

async function prepareContactExportSnapshot(
  idempotencyKey: string,
  spreadsheetIdValue: string | undefined,
  requestedByRole: "admin",
  now: Date,
  snapshotId: string,
  lease: IntegrationSyncLeaseGuard,
): Promise<{
  record: ContactExportSnapshotRecord;
  snapshot: CanonicalContactSnapshot | null;
}> {
  return db.$transaction(
    async (tx) => {
      await lease.fenceTransaction(tx);
      const existing = (await tx.contactExportSnapshot.findUnique({
        where: { idempotencyKey },
      })) as ContactExportSnapshotRecord | null;
      if (existing) {
        if (existing.status === "complete") {
          return { record: existing, snapshot: null };
        }
        const spreadsheetId =
          await resolveGoogleContactExportSpreadsheetId(
            spreadsheetIdValue,
            tx,
          );
        if (
          existing.provider !== EXPORT_PROVIDER ||
          existing.requestedByRole !== requestedByRole ||
          existing.spreadsheetId !== spreadsheetId
        ) {
          throw new ContactExportError(
            "Contact export idempotency key is already bound to another request",
          );
        }
        return {
          record: existing,
          snapshot: snapshotFromRecord(existing),
        };
      }

      const spreadsheetId =
        await resolveGoogleContactExportSpreadsheetId(
          spreadsheetIdValue,
          tx,
        );
      const contacts = await readCanonicalContactRows(tx);
      const snapshot = buildContactSnapshot(contacts, {
        id: snapshotId,
        timestamp: now,
      });
      const record = (await tx.contactExportSnapshot.create({
        data: {
          id: snapshot.id,
          provider: EXPORT_PROVIDER,
          status: "pending",
          idempotencyKey,
          contactCount: snapshot.contactCount,
          contentSha256: snapshot.contentSha256,
          spreadsheetId,
          sheetTabName: contactSnapshotTabName(now, snapshot.id),
          requestedByRole,
          canonicalRows:
            snapshot.rows as unknown as Prisma.InputJsonValue,
          startedAt: now,
        },
      })) as ContactExportSnapshotRecord;
      return { record, snapshot };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}

async function assertSnapshotTabOwnership(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  snapshot: CanonicalContactSnapshot,
): Promise<void> {
  try {
    const response = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A1:B2`,
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = response.data.values ?? [];
    if (rows.length === 0) return;
    const header = rows[0] ?? [];
    const firstContact = rows[1] ?? [];
    const headerOwned =
      header[0] === CONTACT_SNAPSHOT_HEADERS[0] &&
      header[1] === CONTACT_SNAPSHOT_HEADERS[1];
    const contentOwned =
      firstContact.length === 0 || firstContact[1] === snapshot.id;
    if (!headerOwned || !contentOwned) {
      throw new ContactExportError(
        "Google Sheets snapshot tab title is already owned by another export",
      );
    }
  } catch (error) {
    if (error instanceof ContactExportError) throw error;
    throw new ContactExportError(
      "Google Sheets snapshot tab ownership could not be verified",
    );
  }
}

async function resizeSnapshotTab(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetTabId: number,
  currentRows: number,
  currentColumns: number,
  requiredRows: number,
): Promise<void> {
  if (
    currentRows >= requiredRows &&
    currentColumns >= CONTACT_SNAPSHOT_HEADERS.length
  ) {
    return;
  }
  try {
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetTabId,
                gridProperties: {
                  rowCount: Math.max(currentRows, requiredRows),
                  columnCount: Math.max(
                    currentColumns,
                    CONTACT_SNAPSHOT_HEADERS.length,
                  ),
                },
              },
              fields:
                "gridProperties.rowCount,gridProperties.columnCount",
            },
          },
        ],
      },
    });
  } catch {
    throw new ContactExportError(
      "Google Sheets snapshot tab could not be resized",
    );
  }
}

async function findOrCreateSnapshotTab(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  snapshot: CanonicalContactSnapshot,
  expectedSheetTabId: number | null,
): Promise<number> {
  let sheets: sheets_v4.Schema$Sheet[] | undefined;
  try {
    const response = await client.spreadsheets.get({
      spreadsheetId,
      fields:
        "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
    });
    sheets = response.data.sheets;
  } catch {
    throw new ContactExportError(
      "Google Sheets destination metadata could not be read",
    );
  }
  const existing = sheets?.find(
    (sheet) => sheet.properties?.title === title,
  );
  const existingId = existing?.properties?.sheetId;
  if (typeof existingId === "number") {
    if (
      expectedSheetTabId !== null &&
      expectedSheetTabId !== existingId
    ) {
      throw new ContactExportError(
        "Stored contact export tab ID does not match Google Sheets",
      );
    }
    await assertSnapshotTabOwnership(
      client,
      spreadsheetId,
      title,
      snapshot,
    );
    await resizeSnapshotTab(
      client,
      spreadsheetId,
      existingId,
      existing?.properties?.gridProperties?.rowCount ?? 0,
      existing?.properties?.gridProperties?.columnCount ?? 0,
      snapshot.contactCount + 1,
    );
    return existingId;
  }
  if (expectedSheetTabId !== null) {
    throw new ContactExportError(
      "Stored contact export tab no longer exists",
    );
  }

  try {
    const response = await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title,
                gridProperties: {
                  rowCount: Math.max(snapshot.contactCount + 1, 1),
                  columnCount: CONTACT_SNAPSHOT_HEADERS.length,
                },
              },
            },
          },
        ],
      },
    });
    const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (typeof sheetId !== "number") {
      throw new ContactExportError(
        "Google Sheets did not return the new snapshot tab ID",
      );
    }
    return sheetId;
  } catch (error) {
    if (error instanceof ContactExportError) throw error;
    throw new ContactExportError(
      "Google Sheets snapshot tab could not be created",
    );
  }
}

function rowRange(title: string, startRow: number, rowCount: number): string {
  const endRow = startRow + rowCount - 1;
  return `${quoteSheetTitle(title)}!A${startRow}:S${endRow}`;
}

async function writeSnapshotRows(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  rows: readonly ContactSnapshotRow[],
): Promise<void> {
  const googleRows = contactSnapshotGoogleRows(rows);
  try {
    await client.spreadsheets.values.clear({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A:S`,
    });
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: rowRange(title, 1, 1),
      valueInputOption: "RAW",
      requestBody: {
        majorDimension: "ROWS",
        values: [[...CONTACT_SNAPSHOT_HEADERS]],
      },
    });
    for (
      let offset = 0;
      offset < googleRows.length;
      offset += EXPORT_WRITE_BATCH_ROWS
    ) {
      const batch = googleRows.slice(offset, offset + EXPORT_WRITE_BATCH_ROWS);
      await client.spreadsheets.values.update({
        spreadsheetId,
        range: rowRange(title, offset + 2, batch.length),
        valueInputOption: "RAW",
        requestBody: {
          majorDimension: "ROWS",
          values: batch,
        },
      });
    }
  } catch {
    throw new ContactExportError(
      "Google Sheets snapshot rows could not be written",
    );
  }
}

async function verifySnapshotWrite(
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  snapshot: CanonicalContactSnapshot,
): Promise<void> {
  try {
    const headerResponse = await client.spreadsheets.values.get({
      spreadsheetId,
      range: rowRange(title, 1, 1),
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const header = headerResponse.data.values?.[0] ?? [];
    if (
      header.length !== CONTACT_SNAPSHOT_HEADERS.length ||
      header.some(
        (value, index) => value !== CONTACT_SNAPSHOT_HEADERS[index],
      )
    ) {
      throw new ContactExportError(
        "Google Sheets snapshot header verification failed",
      );
    }

    const expectedRows = contactSnapshotGoogleRows(snapshot.rows);
    for (
      let offset = 0;
      offset < expectedRows.length;
      offset += EXPORT_WRITE_BATCH_ROWS
    ) {
      const expectedBatch = expectedRows.slice(
        offset,
        offset + EXPORT_WRITE_BATCH_ROWS,
      );
      const response = await client.spreadsheets.values.get({
        spreadsheetId,
        range: rowRange(title, offset + 2, expectedBatch.length),
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const actualBatch = response.data.values ?? [];
      if (actualBatch.length !== expectedBatch.length) {
        throw new ContactExportError(
          "Google Sheets snapshot row-count verification failed",
        );
      }
      for (const [rowIndex, expectedRow] of expectedBatch.entries()) {
        const actualRow = actualBatch[rowIndex] ?? [];
        for (
          let columnIndex = 0;
          columnIndex < CONTACT_SNAPSHOT_HEADERS.length;
          columnIndex += 1
        ) {
          const expectedValue = expectedRow[columnIndex] ?? "";
          const actualValue = actualRow[columnIndex] ?? "";
          if (actualValue !== expectedValue) {
            throw new ContactExportError(
              "Google Sheets snapshot content verification failed",
            );
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof ContactExportError) throw error;
    throw new ContactExportError(
      "Google Sheets snapshot verification could not be completed",
    );
  }
}

export async function writeContactSnapshotToGoogleSheet(
  snapshot: CanonicalContactSnapshot,
  destination: { spreadsheetId: string; sheetTabName: string },
  client: sheets_v4.Sheets = getGoogleSheetsClient(),
): Promise<{ sheetTabId: number; sheetUrl: string }> {
  const sheetTabId = await findOrCreateSnapshotTab(
    client,
    destination.spreadsheetId,
    destination.sheetTabName,
    snapshot,
    null,
  );
  await writeSnapshotRows(
    client,
    destination.spreadsheetId,
    destination.sheetTabName,
    snapshot.rows,
  );
  await verifySnapshotWrite(
    client,
    destination.spreadsheetId,
    destination.sheetTabName,
    snapshot,
  );
  return {
    sheetTabId,
    sheetUrl: spreadsheetUrl(destination.spreadsheetId, sheetTabId),
  };
}

function safeFailureMessage(error: unknown): string {
  const message =
    error instanceof ContactExportError
      ? error.message
      : "Contact snapshot export failed; retry with the same idempotency key";
  return message.slice(0, MAX_ERROR_LENGTH);
}

export async function exportGoogleContactSnapshot(
  input: ExportGoogleContactSnapshotInput,
  dependencies: GoogleContactExportDependencies = {},
): Promise<ContactExportSummary> {
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const leaseKey = makeIntegrationSyncLeaseKey(
    "contact-export",
    idempotencyKey,
  );
  const result = await withIntegrationSyncLease(
    leaseKey,
    async (lease) => {
      const now = dependencies.now?.() ?? new Date();
      const snapshotId = dependencies.randomId?.() ?? randomUUID();
      let recordId: string | null = null;
      try {
        const prepared = await prepareContactExportSnapshot(
          idempotencyKey,
          input.spreadsheetId ??
            process.env.GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID,
          input.requestedByRole,
          now,
          snapshotId,
          lease,
        );
        recordId = prepared.record.id;
        if (prepared.record.status === "complete") {
          return completedSummary(prepared.record);
        }
        const snapshot = prepared.snapshot;
        if (!snapshot) {
          throw new ContactExportError(
            "Contact snapshot content is unavailable",
          );
        }

        await db.contactExportSnapshot.update({
          where: { id: prepared.record.id },
          data: {
            status: "writing",
            error: null,
            completedAt: null,
            sheetUrl: null,
          },
        });
        const destination = {
          spreadsheetId: prepared.record.spreadsheetId,
          sheetTabName: prepared.record.sheetTabName,
        };
        const client =
          dependencies.sheetsClient ?? getGoogleSheetsClient();
        const sheetTabId = await findOrCreateSnapshotTab(
          client,
          destination.spreadsheetId,
          destination.sheetTabName,
          snapshot,
          prepared.record.sheetTabId,
        );
        await db.$transaction(async (tx) => {
          await lease.fenceTransaction(tx);
          await tx.contactExportSnapshot.update({
            where: { id: prepared.record.id },
            data: { sheetTabId },
          });
        });
        await writeSnapshotRows(
          client,
          destination.spreadsheetId,
          destination.sheetTabName,
          snapshot.rows,
        );
        await verifySnapshotWrite(
          client,
          destination.spreadsheetId,
          destination.sheetTabName,
          snapshot,
        );
        const written = {
          sheetTabId,
          sheetUrl: spreadsheetUrl(
            destination.spreadsheetId,
            sheetTabId,
          ),
        };
        await lease.assertOwned();
        const completedAt = dependencies.now?.() ?? new Date();
        const completed = (await db.$transaction(async (tx) => {
          await lease.fenceTransaction(tx);
          return tx.contactExportSnapshot.update({
            where: { id: prepared.record.id },
            data: {
              status: "complete",
              sheetTabId: written.sheetTabId,
              sheetUrl: written.sheetUrl,
              error: null,
              completedAt,
            },
          });
        })) as ContactExportSnapshotRecord;
        return completedSummary(completed);
      } catch (error) {
        if (recordId) {
          await db.contactExportSnapshot.updateMany({
            where: {
              id: recordId,
              status: { not: "complete" },
            },
            data: {
              status: "failed",
              sheetUrl: null,
              completedAt: null,
              error: safeFailureMessage(error),
            },
          });
        }
        throw error instanceof ContactExportError
          ? error
          : new ContactExportError(safeFailureMessage(error));
      }
    },
    { waitMs: EXPORT_LEASE_WAIT_MS },
  );
  if (!result.ok) throw new ContactExportBusyError();
  return result.data;
}
