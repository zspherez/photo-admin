import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Prisma, type Artist } from "@prisma/client";
import { google, sheets_v4 } from "googleapis";
import { db } from "@/lib/db";
import { normalizeArtistName } from "@/lib/normalize";
import {
  acquireArtistIdentityLock,
  resolveArtists,
  type ArtistIdentityConflict,
  type ArtistIdentityInput,
} from "@/lib/artistIdentity";
import {
  assertOperationTimeRemaining,
  chunkItems,
  isIntegrationSyncLeaseExpired,
  makeIntegrationSyncLeaseKey,
  OperationDeadlineExceededError,
  type IntegrationSyncLeaseGuard,
  type IntegrationSyncLeaseBusyResult,
  type OperationDeadline,
  withIntegrationSyncLease,
} from "@/lib/integrationUtils";
import { normalizeEmail } from "@/lib/resend";
import { CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS } from "@/lib/contactAuditResolutionPolicy";
import { CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE } from "@/lib/directOutreachProvenance";

const SHEET_SOURCE_ID_HEADER = "photo_admin_id";
const SHEET_SYNC_LEASE_WAIT_MS = 2 * 60 * 1_000;
const SHEET_SYNC_LEASE_RETRY_MS = 500;
const SHEET_API_REQUEST_TIMEOUT_MS = 30_000;
const SHEET_SYNC_START_MIN_REMAINING_MS = 45_000;
const SHEET_POST_LEASE_MIN_REMAINING_MS = 40_000;
const SHEET_PRE_WRITE_MIN_REMAINING_MS = 30_000;
const SHEET_POST_WRITE_VERIFY_MIN_REMAINING_MS = 20_000;
const SHEET_DATABASE_MIN_REMAINING_MS = 15_000;
const SHEET_DATABASE_COMPLETION_RESERVE_MS = 1_000;
const SHEET_DATABASE_MAX_WAIT_MS = 10_000;
const SHEET_DATABASE_TIMEOUT_MS = 120_000;
export const SHEETS_SPREADSHEET_ID_SETTING = "sheets_spreadsheet_id";
export const SHEETS_TAB_SETTING = "sheets_tab";
export const SHEETS_TARGET_CHANGE_CONFIRMATION = "CONFIRM";

export interface SheetTarget {
  spreadsheetId: string;
  tabName: string;
}

export class SheetSyncLeaseUnavailableError extends Error {
  readonly leaseKey: string;

  constructor(readonly busy: IntegrationSyncLeaseBusyResult) {
    super(`Sheet sync lease is already held: ${busy.leaseKey}`);
    this.name = "SheetSyncLeaseUnavailableError";
    this.leaseKey = busy.leaseKey;
  }
}

export interface SheetSyncProgress {
  phase: string;
  sheetMutationStarted: boolean;
  databaseMutationStarted: boolean;
}

export interface SheetSyncDeadlineResult {
  ok: false;
  status: "deferred" | "partial";
  reason: "operation_deadline_exceeded";
  details: {
    phase: string;
    operation: string;
    requiredMs: number;
    remainingMs: number;
    sheetMutationStarted: boolean;
    databaseMutationStarted: boolean;
    destructiveWorkStarted: boolean;
  };
}

export type SheetSyncExecutionResult =
  | SheetSyncResult
  | SheetSyncDeadlineResult
  | IntegrationSyncLeaseBusyResult;

export interface SheetTargetOverrides {
  spreadsheetId?: string | null;
  tabName?: string | null;
  confirmTargetChange?: boolean;
}

export interface SheetBootstrapTargetResolution {
  target: SheetTarget;
  source: "override" | "database";
  configuredTarget: SheetTarget | null;
  targetChanged: boolean;
}

export interface SheetBootstrapValidationDependencies {
  getConfiguredTarget?: () => Promise<SheetTarget | null>;
  readTargetHeader?: (target: SheetTarget) => Promise<readonly string[]>;
}

export function sheetSyncDeadlineResult(
  error: OperationDeadlineExceededError,
  progress: SheetSyncProgress
): SheetSyncDeadlineResult {
  const partial =
    progress.sheetMutationStarted || progress.databaseMutationStarted;
  return {
    ok: false,
    status: partial ? "partial" : "deferred",
    reason: "operation_deadline_exceeded",
    details: {
      phase: progress.phase,
      operation: error.operation,
      requiredMs: error.requiredMs,
      remainingMs: error.remainingMs,
      sheetMutationStarted: progress.sheetMutationStarted,
      databaseMutationStarted: progress.databaseMutationStarted,
      destructiveWorkStarted: progress.databaseMutationStarted,
    },
  };
}

export function sheetApiRequestOptions(
  deadline: OperationDeadline | undefined,
  operation: string,
  minimumRemainingAfterMs = 0
): { timeout: number; retry: false } {
  if (!deadline) {
    return { timeout: SHEET_API_REQUEST_TIMEOUT_MS, retry: false };
  }
  const remainingMs = assertOperationTimeRemaining(
    deadline,
    minimumRemainingAfterMs + 1,
    operation
  );
  return {
    timeout: Math.max(
      1,
      Math.floor(
        Math.min(
          SHEET_API_REQUEST_TIMEOUT_MS,
          remainingMs - minimumRemainingAfterMs
        )
      )
    ),
    retry: false,
  };
}

export function sheetDatabaseTransactionTiming(
  deadline?: OperationDeadline
): { maxWait: number; timeout: number; statementTimeoutMs: number } {
  if (!deadline) {
    return {
      maxWait: SHEET_DATABASE_MAX_WAIT_MS,
      timeout: SHEET_DATABASE_TIMEOUT_MS,
      statementTimeoutMs: SHEET_DATABASE_TIMEOUT_MS,
    };
  }
  const remainingMs = assertOperationTimeRemaining(
    deadline,
    SHEET_DATABASE_MIN_REMAINING_MS,
    "Sheets database reconciliation"
  );
  const usableMs = Math.max(
    2,
    Math.floor(remainingMs - SHEET_DATABASE_COMPLETION_RESERVE_MS)
  );
  const maxWait = Math.max(
    1,
    Math.min(SHEET_DATABASE_MAX_WAIT_MS, Math.floor(usableMs / 4))
  );
  const timeout = Math.max(
    1,
    Math.min(SHEET_DATABASE_TIMEOUT_MS, usableMs - maxWait)
  );
  return { maxWait, timeout, statementTimeoutMs: timeout };
}

export function makeSheetSyncLeaseKey(
  sheetId: string,
  tabName: string
): string {
  return makeIntegrationSyncLeaseKey("sheets", sheetId, tabName);
}

export function makeSheetConfigurationLeaseKey(): string {
  return makeIntegrationSyncLeaseKey("sheets-configuration");
}

export function isSheetSyncLeaseExpired(
  expiresAt: Date,
  now: Date
): boolean {
  return isIntegrationSyncLeaseExpired(expiresAt, now);
}

async function withSheetSyncLease<T>(
  sheetId: string,
  tabName: string,
  work: (lease: IntegrationSyncLeaseGuard) => Promise<T>,
  deadline?: OperationDeadline
): Promise<T> {
  const key = makeSheetSyncLeaseKey(sheetId, tabName);
  const result = await withIntegrationSyncLease(key, work, {
    waitMs: SHEET_SYNC_LEASE_WAIT_MS,
    retryMs: SHEET_SYNC_LEASE_RETRY_MS,
    deadline,
    minimumRemainingMs: SHEET_POST_LEASE_MIN_REMAINING_MS,
  });
  if (!result.ok) throw new SheetSyncLeaseUnavailableError(result);
  return result.data;
}

async function withSheetConfigurationLease<T>(
  work: (lease: IntegrationSyncLeaseGuard) => Promise<T>,
  deadline?: OperationDeadline
): Promise<T> {
  const result = await withIntegrationSyncLease(
    makeSheetConfigurationLeaseKey(),
    work,
    {
      waitMs: SHEET_SYNC_LEASE_WAIT_MS,
      retryMs: SHEET_SYNC_LEASE_RETRY_MS,
      deadline,
      minimumRemainingMs: SHEET_POST_LEASE_MIN_REMAINING_MS,
    }
  );
  if (!result.ok) throw new SheetSyncLeaseUnavailableError(result);
  return result.data;
}

function loadGoogleCreds(): { client_email: string; private_key: string } {
  const jsonEnv = process.env.GOOGLE_CREDENTIALS_JSON;
  let value: unknown;
  if (jsonEnv) {
    value = JSON.parse(jsonEnv);
  } else {
    const path = process.env.GOOGLE_CREDENTIALS_PATH;
    if (path) value = JSON.parse(readFileSync(path, "utf-8"));
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "client_email") !== "string" ||
    !Reflect.get(value, "client_email") ||
    typeof Reflect.get(value, "private_key") !== "string" ||
    !Reflect.get(value, "private_key")
  ) {
    throw new Error(
      "Missing or invalid GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH"
    );
  }
  return {
    client_email: Reflect.get(value, "client_email") as string,
    private_key: Reflect.get(value, "private_key") as string,
  };
}

export function validateGoogleSheetsCredentials(): void {
  loadGoogleCreds();
}

function getSheetsClient(): sheets_v4.Sheets {
  const credentials = loadGoogleCreds();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function environmentSpreadsheetId(): string {
  const value = process.env.SPREADSHEET_ID?.trim();
  if (!value) throw new Error("Missing SPREADSHEET_ID");
  return value;
}

function requireSheetTab(tabName: string): string {
  const value = tabName.trim();
  if (!value) throw new Error("Google Sheet tab is required");
  return value;
}

export function configuredSheetTargetFromValues(
  spreadsheetIdValue: string | null | undefined,
  tabNameValue: string | null | undefined
): SheetTarget | null {
  const configuredSpreadsheetId = spreadsheetIdValue?.trim() ?? "";
  const configuredTab = tabNameValue?.trim() ?? "";
  if (!configuredSpreadsheetId && !configuredTab) return null;
  if (!configuredSpreadsheetId || !configuredTab) {
    throw new Error(
      `Google Sheets target settings are incomplete; both ${SHEETS_SPREADSHEET_ID_SETTING} and ${SHEETS_TAB_SETTING} are required`
    );
  }
  return {
    spreadsheetId: configuredSpreadsheetId,
    tabName: configuredTab,
  };
}

export function resolveSheetBootstrapTargetFromValues(
  overrideSpreadsheetId: string | null | undefined,
  overrideTabName: string | null | undefined,
  databaseSpreadsheetId: string | null | undefined,
  databaseTabName: string | null | undefined,
  confirmTargetChange = false
): SheetBootstrapTargetResolution {
  const override = configuredSheetTargetFromValues(
    overrideSpreadsheetId,
    overrideTabName
  );
  const configured = configuredSheetTargetFromValues(
    databaseSpreadsheetId,
    databaseTabName
  );
  const target = override ?? configured;
  if (!target) {
    throw new Error(
      `Google Sheets target is not configured; provide SHEETS_SPREADSHEET_ID and SHEETS_TAB or set ${SHEETS_SPREADSHEET_ID_SETTING} and ${SHEETS_TAB_SETTING}`
    );
  }
  const targetChanged =
    configured !== null && !sameSheetTarget(configured, target);
  if (targetChanged && !confirmTargetChange) {
    throw new Error(
      `Protected Google Sheets target differs from the stored database target; set SHEETS_TARGET_CHANGE_CONFIRMATION=${SHEETS_TARGET_CHANGE_CONFIRMATION} for an intentional switch`
    );
  }
  return {
    target,
    source: override ? "override" : "database",
    configuredTarget: configured,
    targetChanged,
  };
}

export async function getConfiguredSheetTarget(): Promise<SheetTarget | null> {
  const settings = await db.setting.findMany({
    where: {
      key: {
        in: [SHEETS_SPREADSHEET_ID_SETTING, SHEETS_TAB_SETTING],
      },
    },
    select: { key: true, value: true },
  });
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));
  return configuredSheetTargetFromValues(
    values.get(SHEETS_SPREADSHEET_ID_SETTING),
    values.get(SHEETS_TAB_SETTING)
  );
}

async function requireConfiguredSheetTarget(): Promise<SheetTarget> {
  const target = await getConfiguredSheetTarget();
  if (!target) {
    throw new Error(
      `Google Sheets target is not configured; set ${SHEETS_SPREADSHEET_ID_SETTING} and ${SHEETS_TAB_SETTING}`
    );
  }
  return target;
}

export function sameSheetTarget(
  left: SheetTarget,
  right: SheetTarget
): boolean {
  return (
    left.spreadsheetId === right.spreadsheetId &&
    left.tabName === right.tabName
  );
}

export class SheetTargetCompareAndSetError extends Error {
  constructor(
    readonly expected: SheetTarget | null,
    readonly actual: SheetTarget | null
  ) {
    super(
      "Google Sheets target changed after preflight; refusing stale reconciliation"
    );
    this.name = "SheetTargetCompareAndSetError";
  }
}

export function assertExpectedPreviousSheetTarget(
  expected: SheetTarget | null,
  actual: SheetTarget | null
): void {
  if (
    (expected === null && actual === null) ||
    (expected !== null &&
      actual !== null &&
      sameSheetTarget(expected, actual))
  ) {
    return;
  }
  throw new SheetTargetCompareAndSetError(expected, actual);
}

async function assertConfiguredSheetTarget(target: SheetTarget): Promise<void> {
  const configured = await getConfiguredSheetTarget();
  if (!configured || !sameSheetTarget(configured, target)) {
    throw new Error("Configured Google Sheets target verification failed");
  }
}

export async function validateSheetBootstrapTarget(
  overrides: SheetTargetOverrides = {},
  dependencies: SheetBootstrapValidationDependencies = {}
): Promise<SheetBootstrapTargetResolution> {
  const configured = await (
    dependencies.getConfiguredTarget ?? getConfiguredSheetTarget
  )();
  const resolution = resolveSheetBootstrapTargetFromValues(
    overrides.spreadsheetId,
    overrides.tabName,
    configured?.spreadsheetId,
    configured?.tabName,
    overrides.confirmTargetChange
  );
  const header = await (
    dependencies.readTargetHeader ?? readSheetTargetHeader
  )(resolution.target);
  assertContactIdentityHeader(resolution.target, header);
  return resolution;
}

async function targetForManualSync(tabName: string): Promise<SheetTarget> {
  const configured = await getConfiguredSheetTarget();
  return {
    spreadsheetId:
      configured?.spreadsheetId ?? environmentSpreadsheetId(),
    tabName: requireSheetTab(tabName),
  };
}

function quoteTab(tabName: string): string {
  return `'${tabName.replaceAll("'", "''")}'`;
}

export async function listTabs(
  configuredSpreadsheetId?: string
): Promise<string[]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get(
    {
      spreadsheetId:
        configuredSpreadsheetId?.trim() || environmentSpreadsheetId(),
      fields: "sheets.properties.title",
    },
    sheetApiRequestOptions(undefined, "List Google Sheet tabs")
  );
  return (response.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => Boolean(title));
}

export type SheetRow = Record<string, string>;

interface RawSheet {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  tabName: string;
  headerRaw: string[];
  header: string[];
  rows: string[][];
}

function stringifySheetValues(values: unknown[][] | null | undefined): string[][] {
  return (values ?? []).map((row) =>
    row.map((value) => (value == null ? "" : String(value)))
  );
}

async function readRawSheet(
  target: SheetTarget,
  deadline?: OperationDeadline,
  minimumRemainingAfterMs = 0
): Promise<RawSheet> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: target.spreadsheetId,
      range: `${quoteTab(target.tabName)}!A:ZZ`,
      valueRenderOption: "FORMATTED_VALUE",
    },
    sheetApiRequestOptions(
      deadline,
      "Read Google Sheet contact rows",
      minimumRemainingAfterMs
    )
  );
  const values = stringifySheetValues(response.data.values);
  if (values.length === 0) {
    throw new Error(`Sheet tab "${target.tabName}" has no header row`);
  }
  const [headerRaw, ...rows] = values;
  const header = headerRaw.map((value) => (value ?? "").trim().toLowerCase());
  const sourceIdColumn = header.indexOf(SHEET_SOURCE_ID_HEADER);
  if (sourceIdColumn >= 0) {
    const sourceColumn = colNumToLetter(sourceIdColumn + 1);
    const identityResponse = await sheets.spreadsheets.values.get(
      {
        spreadsheetId: target.spreadsheetId,
        range: `${quoteTab(target.tabName)}!${sourceColumn}:${sourceColumn}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      },
      sheetApiRequestOptions(
        deadline,
        "Read Google Sheet stable row identities",
        minimumRemainingAfterMs
      )
    );
    const identityValues = stringifySheetValues(identityResponse.data.values);
    rows.forEach((row, index) => {
      row[sourceIdColumn] = identityValues[index + 1]?.[0] ?? "";
    });
  }
  return {
    sheets,
    spreadsheetId: target.spreadsheetId,
    tabName: target.tabName,
    headerRaw,
    header,
    rows,
  };
}

async function readSheetTargetHeader(
  target: SheetTarget
): Promise<readonly string[]> {
  const sheets = getSheetsClient();
  const structure = await sheets.spreadsheets.get(
    {
      spreadsheetId: target.spreadsheetId,
      fields:
        "spreadsheetId,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
    },
    sheetApiRequestOptions(undefined, "Read Google Sheet structure")
  );
  const tab = structure.data.sheets?.find(
    (sheet) => sheet.properties?.title === target.tabName
  );
  if (tab?.properties?.sheetId == null) {
    throw new Error(
      `Sheet tab "${target.tabName}" does not exist in the configured spreadsheet`
    );
  }
  if (
    (tab.properties.gridProperties?.rowCount ?? 0) < 1 ||
    (tab.properties.gridProperties?.columnCount ?? 0) < 2
  ) {
    throw new Error(
      `Sheet tab "${target.tabName}" does not have a usable contact grid`
    );
  }

  const response = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: target.spreadsheetId,
      range: `${quoteTab(target.tabName)}!A1:ZZ1`,
      valueRenderOption: "FORMATTED_VALUE",
    },
    sheetApiRequestOptions(undefined, "Read Google Sheet contact header")
  );
  const header = stringifySheetValues(response.data.values)[0];
  if (!header) {
    throw new Error(`Sheet tab "${target.tabName}" has no header row`);
  }
  return header.map((value) => value.trim().toLowerCase());
}

export async function readTab(tabName: string): Promise<SheetRow[]> {
  const sheet = await readRawSheet(await targetForManualSync(tabName));
  return sheet.rows.map((row) => {
    const item: SheetRow = {};
    sheet.header.forEach((key, index) => {
      if (key) item[key] = (row[index] ?? "").trim();
    });
    return item;
  });
}

function colNumToLetter(value: number): string {
  let result = "";
  let current = value;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function findColumn(header: readonly string[], names: readonly string[]): number {
  return header.findIndex((value) => names.includes(value));
}

interface IdentifiedSheet extends RawSheet {
  sourceIdColumn: number;
}

function assertContactIdentityHeader(
  target: SheetTarget,
  header: readonly string[]
): { artistColumn: number; emailColumn: number } {
  const artistColumn = findColumn(header, ["artist", "artist name"]);
  const emailColumn = header.indexOf("email");
  if (artistColumn < 0 || emailColumn < 0) {
    throw new Error(
      `Sheet tab "${target.tabName}" requires artist (or artist name) and email columns`
    );
  }
  return { artistColumn, emailColumn };
}

function contactIdentityColumns(sheet: RawSheet): {
  artistColumn: number;
  emailColumn: number;
} {
  return assertContactIdentityHeader(sheet, sheet.header);
}

async function ensureStableRowIds(
  sheet: RawSheet,
  deadline?: OperationDeadline,
  progress?: SheetSyncProgress
): Promise<IdentifiedSheet> {
  let sourceIdColumn = sheet.header.indexOf(SHEET_SOURCE_ID_HEADER);
  const updates: sheets_v4.Schema$ValueRange[] = [];
  if (sourceIdColumn < 0) {
    sourceIdColumn = sheet.headerRaw.length;
    if (sourceIdColumn >= 702) {
      throw new Error("Sheet has no room for a stable contact identity column");
    }
    sheet.headerRaw[sourceIdColumn] = SHEET_SOURCE_ID_HEADER;
    sheet.header[sourceIdColumn] = SHEET_SOURCE_ID_HEADER;
    updates.push({
      range: `${quoteTab(sheet.tabName)}!${colNumToLetter(sourceIdColumn + 1)}1`,
      values: [[SHEET_SOURCE_ID_HEADER]],
    });
  }

  const { artistColumn, emailColumn } = contactIdentityColumns(sheet);

  const seenIds = new Set<string>();
  sheet.rows.forEach((row, index) => {
    const hasContactData = Boolean(
      (row[artistColumn] ?? "").trim() || (row[emailColumn] ?? "").trim()
    );
    if (!hasContactData) return;
    let rowId = (row[sourceIdColumn] ?? "").trim();
    if (!rowId) {
      rowId = randomUUID();
      row[sourceIdColumn] = rowId;
      updates.push({
        range: `${quoteTab(sheet.tabName)}!${colNumToLetter(
          sourceIdColumn + 1
        )}${index + 2}`,
        values: [[rowId]],
      });
    }
    if (seenIds.has(rowId)) {
      throw new Error(`Sheet tab "${sheet.tabName}" has duplicate row id ${rowId}`);
    }
    seenIds.add(rowId);
  });

  for (const updateChunk of chunkItems(updates, 500)) {
    if (deadline) {
      assertOperationTimeRemaining(
        deadline,
        SHEET_PRE_WRITE_MIN_REMAINING_MS,
        "Persist Google Sheet stable row identities"
      );
    }
    if (progress) {
      progress.phase = "stable_row_identity_write";
      progress.sheetMutationStarted = true;
    }
    await sheet.sheets.spreadsheets.values.batchUpdate(
      {
        spreadsheetId: sheet.spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updateChunk,
        },
      },
      sheetApiRequestOptions(
        deadline,
        "Persist Google Sheet stable row identities",
        SHEET_POST_WRITE_VERIFY_MIN_REMAINING_MS
      )
    );
  }
  return { ...sheet, sourceIdColumn };
}

function requireStableRowIds(sheet: RawSheet): IdentifiedSheet {
  const sourceIdColumn = sheet.header.indexOf(SHEET_SOURCE_ID_HEADER);
  if (sourceIdColumn < 0) {
    throw new Error(
      `Sheet tab "${sheet.tabName}" did not persist its ${SHEET_SOURCE_ID_HEADER} column`
    );
  }
  const { artistColumn, emailColumn } = contactIdentityColumns(sheet);
  const seenIds = new Set<string>();
  sheet.rows.forEach((row, index) => {
    const hasContactData = Boolean(
      (row[artistColumn] ?? "").trim() || (row[emailColumn] ?? "").trim()
    );
    if (!hasContactData) return;
    const rowId = (row[sourceIdColumn] ?? "").trim();
    if (!rowId) {
      throw new Error(
        `Sheet tab "${sheet.tabName}" row ${index + 2} did not persist its stable identity`
      );
    }
    if (seenIds.has(rowId)) {
      throw new Error(`Sheet tab "${sheet.tabName}" has duplicate row id ${rowId}`);
    }
    seenIds.add(rowId);
  });
  return { ...sheet, sourceIdColumn };
}

export function parseSheetEmails(value: string): {
  emails: string[];
  isFullTeam: boolean;
} {
  const isFullTeam = /full\s*teams?/i.test(value);
  const emails: string[] = [];
  const seen = new Set<string>();
  const candidates = value
    .replace(/full\s*teams?/gi, "")
    .matchAll(/<([^<>]+)>|([^\s,;<>]+@[^\s,;<>]+)/g);
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate[1] ?? candidate[2] ?? "");
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return { emails, isFullTeam };
}

export type ContactSheetRowDisposition =
  | "empty"
  | "email"
  | "direct_outreach"
  | "invalid_missing_artist"
  | "invalid_missing_contact";

export function contactSheetRowDisposition(
  artistName: string,
  emailValue: string
): ContactSheetRowDisposition {
  const artist = artistName.trim();
  const contactCell = emailValue.trim();
  if (!artist && !contactCell) return "empty";
  if (!artist) return "invalid_missing_artist";
  if (!contactCell) return "invalid_missing_contact";
  return parseSheetEmails(contactCell).emails.length > 0
    ? "email"
    : "direct_outreach";
}

function composeSheetEmails(emails: readonly string[], isFullTeam: boolean): string {
  const value = emails.join(", ");
  return isFullTeam ? `${value}${value ? " " : ""}full teams` : value;
}

function sourceToken(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function sourcePrefix(target: SheetTarget): string {
  return `sheet:v2:${sourceToken(target.spreadsheetId)}:${sourceToken(
    target.tabName
  )}:`;
}

function legacySourcePrefix(tabName: string): string {
  return `sheet:${sourceToken(tabName)}:`;
}

function sourcePrefixes(
  target: SheetTarget,
  allowLegacyOwnership: boolean
): string[] {
  return [
    sourcePrefix(target),
    ...(allowLegacyOwnership ? [legacySourcePrefix(target.tabName)] : []),
  ];
}

export interface ParsedSheetSourceKey {
  spreadsheetId: string | null;
  tabName: string;
  rowId: string;
  slot: number;
}

export function makeSheetSourceKey(
  target: SheetTarget,
  rowId: string,
  slot: number
): string {
  if (!target.spreadsheetId.trim()) {
    throw new Error("Invalid Sheet spreadsheet identity");
  }
  if (!rowId || rowId.includes(":")) throw new Error("Invalid Sheet row identity");
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error("Invalid Sheet contact slot");
  }
  return `${sourcePrefix(target)}${rowId}:${slot}`;
}

function decodedSourceToken(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf-8");
    return decoded.trim() && sourceToken(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function parseSheetSourceKey(
  value: string
): ParsedSheetSourceKey | null {
  const current = /^sheet:v2:([^:]+):([^:]+):([^:]+):(\d+)$/.exec(value);
  const legacy = current
    ? null
    : /^sheet:([^:]+):([^:]+):(\d+)$/.exec(value);
  const match = current ?? legacy;
  if (!match) return null;

  const spreadsheetId = current ? decodedSourceToken(match[1]) : null;
  const tabTokenIndex = current ? 2 : 1;
  const rowIdIndex = current ? 3 : 2;
  const slotIndex = current ? 4 : 3;
  const tabName = decodedSourceToken(match[tabTokenIndex]);
  const rowId = match[rowIdIndex];
  const slot = Number(match[slotIndex]);
  if (
    (current && !spreadsheetId) ||
    !tabName ||
    !rowId ||
    !Number.isSafeInteger(slot) ||
    String(slot) !== match[slotIndex]
  ) {
    return null;
  }
  return {
    spreadsheetId,
    tabName,
    rowId,
    slot,
  };
}

export function sheetSourceKeyBelongsToTarget(
  sourceKey: string,
  target: SheetTarget,
  allowLegacyOwnership: boolean
): boolean {
  const source = parseSheetSourceKey(sourceKey);
  if (!source || source.tabName !== target.tabName) return false;
  return source.spreadsheetId === target.spreadsheetId ||
    (allowLegacyOwnership && source.spreadsheetId === null);
}

export function resolveSheetMutationTarget(
  configuredTarget: SheetTarget,
  sourceKey?: string | null
): SheetTarget {
  const target = {
    spreadsheetId: configuredTarget.spreadsheetId.trim(),
    tabName: requireSheetTab(configuredTarget.tabName),
  };
  if (!target.spreadsheetId) throw new Error("Google Sheet target is required");
  if (!sourceKey) return target;
  const source = parseSheetSourceKey(sourceKey);
  if (!source) throw new Error("Contact has an invalid Sheet source identity");
  if (
    source.tabName !== target.tabName ||
    (source.spreadsheetId !== null &&
      source.spreadsheetId !== target.spreadsheetId)
  ) {
    throw new Error(
      "Contact Sheet source does not match the configured spreadsheet and tab"
    );
  }
  return target;
}

async function targetForSheetMutation(
  sourceKey?: string | null
): Promise<SheetTarget> {
  return resolveSheetMutationTarget(
    await requireConfiguredSheetTarget(),
    sourceKey
  );
}

export interface ExistingSheetContactSlot {
  sourceKey: string;
  slot: number;
  email: string | null;
}

export interface SheetContactAssignment {
  sourceKey: string;
  priorSourceKey: string | null;
  slot: number;
  email: string | null;
  priorEmail: string | null;
  directOutreachNote: string | null;
}

export function reconcileSheetContactSlots(
  target: SheetTarget,
  rowId: string,
  existing: readonly ExistingSheetContactSlot[],
  incomingRow: {
    emails: readonly string[];
    directOutreachNote: string | null;
  }
): { assignments: SheetContactAssignment[]; removedSourceKeys: string[] } {
  const incomingEmails = Array.from(
    new Set(
      incomingRow.emails
        .map((email) => normalizeEmail(email))
        .filter((email): email is string => email !== null)
    )
  );
  const directOutreachNote = incomingRow.directOutreachNote?.trim() || null;
  if (incomingEmails.length > 0 && directOutreachNote) {
    throw new Error("A Sheet row cannot mix email and direct outreach targets");
  }
  const unused = new Map(existing.map((slot) => [slot.sourceKey, slot]));
  if (directOutreachNote) {
    const prior =
      existing.find((slot) => slot.slot === 0) ??
      [...existing].sort((left, right) => left.slot - right.slot)[0] ??
      null;
    if (prior) unused.delete(prior.sourceKey);
    return {
      assignments: [
        {
          sourceKey: makeSheetSourceKey(target, rowId, 0),
          priorSourceKey: prior?.sourceKey ?? null,
          slot: 0,
          email: null,
          priorEmail: prior?.email ?? null,
          directOutreachNote,
        },
      ],
      removedSourceKeys: Array.from(unused.keys()),
    };
  }

  const assignments: SheetContactAssignment[] = [];
  const pending: string[] = [];

  for (const email of incomingEmails) {
    const exact = Array.from(unused.values()).find(
      (slot) => normalizeEmail(slot.email ?? "") === email
    );
    if (!exact) {
      pending.push(email);
      continue;
    }
    unused.delete(exact.sourceKey);
    assignments.push({
      sourceKey: makeSheetSourceKey(target, rowId, exact.slot),
      priorSourceKey: exact.sourceKey,
      slot: exact.slot,
      email,
      priorEmail: exact.email,
      directOutreachNote: null,
    });
  }

  const reusable = Array.from(unused.values()).sort((a, b) => a.slot - b.slot);
  const usedSlots = new Set(existing.map((slot) => slot.slot));
  let nextSlot = 0;
  const allocateSlot = () => {
    while (usedSlots.has(nextSlot)) nextSlot++;
    usedSlots.add(nextSlot);
    return nextSlot++;
  };

  for (const email of pending) {
    const prior = reusable.shift();
    if (prior) {
      unused.delete(prior.sourceKey);
      assignments.push({
        sourceKey: makeSheetSourceKey(target, rowId, prior.slot),
        priorSourceKey: prior.sourceKey,
        slot: prior.slot,
        email,
        priorEmail: prior.email,
        directOutreachNote: null,
      });
    } else {
      const slot = allocateSlot();
      assignments.push({
        sourceKey: makeSheetSourceKey(target, rowId, slot),
        priorSourceKey: null,
        slot,
        email,
        priorEmail: null,
        directOutreachNote: null,
      });
    }
  }

  assignments.sort(
    (left, right) =>
      incomingEmails.indexOf(left.email!) - incomingEmails.indexOf(right.email!)
  );
  return {
    assignments,
    removedSourceKeys: Array.from(unused.keys()),
  };
}

export interface ExistingEmailSlot {
  sourceKey: string;
  slot: number;
  email: string;
}

export interface SheetEmailAssignment {
  sourceKey: string;
  priorSourceKey: string | null;
  slot: number;
  email: string;
  priorEmail: string | null;
}

export function reconcileSheetEmailSlots(
  target: SheetTarget,
  rowId: string,
  existing: readonly ExistingEmailSlot[],
  incomingEmails: readonly string[]
): { assignments: SheetEmailAssignment[]; removedSourceKeys: string[] } {
  const result = reconcileSheetContactSlots(target, rowId, existing, {
    emails: incomingEmails,
    directOutreachNote: null,
  });
  return {
    assignments: result.assignments.map((assignment) => {
      if (!assignment.email) {
        throw new Error("Email reconciliation produced a non-email contact");
      }
      return {
        sourceKey: assignment.sourceKey,
        priorSourceKey: assignment.priorSourceKey,
        slot: assignment.slot,
        email: assignment.email,
        priorEmail: assignment.priorEmail,
      };
    }),
    removedSourceKeys: result.removedSourceKeys,
  };
}

export interface LegacySheetContactCandidate {
  id: string;
  source: string | null;
  sourceKey: string | null;
  state: "active" | "quarantined";
  email: string | null;
  artist: {
    id: string;
    normalizedName: string;
  };
}

export type LegacySheetRowAdoption =
  | { kind: "none" }
  | { kind: "ambiguous"; artistIds: string[] }
  | { kind: "adopt"; artistId: string; contactIds: string[] };

export function selectLegacySheetRowAdoption(
  normalizedName: string,
  emails: readonly string[],
  contacts: readonly LegacySheetContactCandidate[]
): LegacySheetRowAdoption {
  const incomingEmails = new Set(
    emails.map((email) => email.trim().toLowerCase())
  );
  const matches = contacts.filter(
    (contact) =>
      contact.source === "sheet" &&
      contact.sourceKey === null &&
      contact.state === "quarantined" &&
      contact.email !== null &&
      incomingEmails.has(contact.email.toLowerCase()) &&
      contact.artist.normalizedName === normalizedName
  );
  if (matches.length === 0) return { kind: "none" };

  const artistIds = Array.from(
    new Set(matches.map((contact) => contact.artist.id))
  );
  if (artistIds.length !== 1) {
    return { kind: "ambiguous", artistIds };
  }
  return {
    kind: "adopt",
    artistId: artistIds[0],
    contactIds: matches.map((contact) => contact.id),
  };
}

export interface LegacySheetAdoptionRow {
  rowId: string;
  artistName: string;
  emails: readonly string[];
}

export interface LegacySheetAdoptionConflict {
  rowId: string;
  artistIds: string[];
}

export function remainingLegacySheetAdoptions(
  rows: readonly LegacySheetAdoptionRow[],
  contacts: readonly LegacySheetContactCandidate[]
): {
  contactIds: string[];
  conflicts: LegacySheetAdoptionConflict[];
} {
  const contactIds = new Set<string>();
  const conflicts: LegacySheetAdoptionConflict[] = [];
  for (const row of rows) {
    const adoption = selectLegacySheetRowAdoption(
      normalizeArtistName(row.artistName),
      row.emails,
      contacts
    );
    if (adoption.kind === "adopt") {
      adoption.contactIds.forEach((contactId) => contactIds.add(contactId));
    } else if (adoption.kind === "ambiguous") {
      conflicts.push({ rowId: row.rowId, artistIds: adoption.artistIds });
    }
  }
  return { contactIds: Array.from(contactIds), conflicts };
}

export interface SheetContactOwnership {
  id: string;
  sourceKey: string | null;
  preserveAuditHistory?: boolean;
}

export function staleOwnedSheetContactIds(
  target: SheetTarget,
  allowLegacyOwnership: boolean,
  contacts: readonly SheetContactOwnership[],
  claimedContactIds: ReadonlySet<string>,
  seenSourceKeys: ReadonlySet<string>
): string[] {
  return contacts
    .filter(
      (contact) =>
        !claimedContactIds.has(contact.id) &&
        !contact.preserveAuditHistory &&
        contact.sourceKey !== null &&
        sheetSourceKeyBelongsToTarget(
          contact.sourceKey,
          target,
          allowLegacyOwnership
        ) &&
        !seenSourceKeys.has(contact.sourceKey)
    )
    .map((contact) => contact.id);
}

export function shouldKeepApprovedStaleSheetContactQuarantined(
  contact: {
    auditJobs: readonly {
      resolution: string | null;
      finding: string | null;
      resolvedEmail: string | null;
      resolvedDirectOutreachNote: string | null;
    }[];
  },
  incoming: {
    email: string | null;
    directOutreachNote: string | null;
  }
): boolean {
  const incomingEmail = normalizeEmail(incoming.email ?? "");
  const incomingDirectOutreachNote =
    incoming.directOutreachNote?.trim() || null;
  return contact.auditJobs.some((job) => {
    if (job.resolution !== "approved" || job.finding !== "stale") {
      return false;
    }
    const resolvedEmail = normalizeEmail(job.resolvedEmail ?? "");
    const resolvedDirectOutreachNote =
      job.resolvedDirectOutreachNote?.trim() || null;
    return incomingEmail
      ? resolvedEmail === incomingEmail
      : Boolean(
          incomingDirectOutreachNote &&
            resolvedDirectOutreachNote === incomingDirectOutreachNote
        );
  });
}

interface ContactSheetRow {
  rowId: string;
  artistName: string;
  emails: string[];
  directOutreachNote: string | null;
  isFullTeam: boolean;
  name: string | null;
  role: string | null;
  customPrice: string | null;
  notes: string | null;
}

export interface SheetOwnedContactDataInput {
  artistId: string;
  email: string | null;
  directOutreachNote: string | null;
  sourceKey: string;
  row: Pick<
    ContactSheetRow,
    "name" | "role" | "customPrice" | "notes" | "isFullTeam"
  >;
}

export function sheetOwnedContactData(
  input: SheetOwnedContactDataInput,
  now: Date,
) {
  return {
    artistId: input.artistId,
    email: input.email,
    directOutreachNote: input.directOutreachNote,
    ...CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE,
    name: input.row.name,
    role: input.row.role,
    customPrice: input.row.customPrice,
    notes: input.row.notes,
    source: "sheet",
    sourceKey: input.sourceKey,
    sourceSyncedAt: now,
    isFullTeam: input.row.isFullTeam,
  };
}

function contactRows(sheet: IdentifiedSheet): {
  rows: ContactSheetRow[];
  skipped: number;
} {
  const artistColumn = findColumn(sheet.header, ["artist", "artist name"]);
  const emailColumn = sheet.header.indexOf("email");
  const nameColumn = findColumn(sheet.header, ["manager_name", "manager name"]);
  const roleColumn = sheet.header.indexOf("role");
  const priceColumn = findColumn(sheet.header, ["price", "rate"]);
  const notesColumn = sheet.header.indexOf("notes");
  const rows: ContactSheetRow[] = [];
  let skipped = 0;

  for (const [index, row] of sheet.rows.entries()) {
    const artistName = (row[artistColumn] ?? "").trim();
    const emailValue = (row[emailColumn] ?? "").trim();
    const disposition = contactSheetRowDisposition(artistName, emailValue);
    if (disposition === "empty") continue;
    if (
      disposition === "invalid_missing_artist" ||
      disposition === "invalid_missing_contact"
    ) {
      skipped++;
      console.warn(
        JSON.stringify({
          event: "sheet_contact_row_skipped",
          tabName: sheet.tabName,
          row: index + 2,
          reason:
            disposition === "invalid_missing_artist"
              ? "missing_artist"
              : "missing_contact",
        })
      );
      continue;
    }
    const parsed = parseSheetEmails(emailValue);
    const rowId = (row[sheet.sourceIdColumn] ?? "").trim();
    if (!rowId) {
      throw new Error("Sheet contact row is missing its stable identity");
    }
    rows.push({
      rowId,
      artistName,
      emails: parsed.emails,
      directOutreachNote:
        disposition === "direct_outreach" ? emailValue : null,
      isFullTeam: disposition === "email" && parsed.isFullTeam,
      name: nameColumn >= 0 ? (row[nameColumn] ?? "").trim() || null : null,
      role: roleColumn >= 0 ? (row[roleColumn] ?? "").trim() || null : null,
      customPrice:
        priceColumn >= 0 ? (row[priceColumn] ?? "").trim() || null : null,
      notes: notesColumn >= 0 ? (row[notesColumn] ?? "").trim() || null : null,
    });
  }
  return { rows, skipped };
}

export interface SheetSyncResult {
  tabName: string;
  read: number;
  contactsUpserted: number;
  contactsDeleted: number;
  contactsQuarantined: number;
  legacyContactsAdopted: number;
  adoptionVerified: boolean;
  artistsCreated: number;
  skipped: number;
  rowsIdentified: number;
  identityConflicts: ArtistIdentityConflict[];
}

export async function syncContactsFromSheet(
  tabName: string
): Promise<SheetSyncResult> {
  const configuredTarget = await getConfiguredSheetTarget();
  const target = {
    spreadsheetId:
      configuredTarget?.spreadsheetId ?? environmentSpreadsheetId(),
    tabName: requireSheetTab(tabName),
  };
  return syncContactsAtTarget(target, undefined, undefined, {
    configuredTarget,
  });
}

export async function syncConfiguredContactsFromSheet(): Promise<SheetSyncResult>;
export async function syncConfiguredContactsFromSheet(
  deadline: OperationDeadline
): Promise<SheetSyncExecutionResult>;
export async function syncConfiguredContactsFromSheet(
  deadline?: OperationDeadline
): Promise<SheetSyncExecutionResult> {
  const progress: SheetSyncProgress = {
    phase: "target_configuration",
    sheetMutationStarted: false,
    databaseMutationStarted: false,
  };
  try {
    if (deadline) {
      assertOperationTimeRemaining(
        deadline,
        SHEET_SYNC_START_MIN_REMAINING_MS,
        "Sheets contact sync"
      );
    }
    const target = await requireConfiguredSheetTarget();
    return await syncContactsAtTarget(target, deadline, progress, {
      configuredTarget: target,
    });
  } catch (error) {
    if (!deadline) throw error;
    if (error instanceof SheetSyncLeaseUnavailableError) return error.busy;
    if (error instanceof OperationDeadlineExceededError) {
      return sheetSyncDeadlineResult(error, progress);
    }
    throw error;
  }
}

export async function adoptConfiguredSheetContacts(
  overrides: SheetTargetOverrides = {}
): Promise<
  SheetSyncResult & {
    targetSource: SheetBootstrapTargetResolution["source"];
    targetChanged: boolean;
  }
> {
  const resolution = await validateSheetBootstrapTarget(overrides);
  const result = await syncContactsAtTarget(
    resolution.target,
    undefined,
    undefined,
    { configuredTarget: resolution.configuredTarget }
  );
  if (!result.adoptionVerified || result.identityConflicts.length > 0) {
    throw new Error(
      `Configured Sheet adoption did not complete for tab "${result.tabName}"`
    );
  }
  await assertConfiguredSheetTarget(resolution.target);
  return {
    ...result,
    targetSource: resolution.source,
    targetChanged: resolution.targetChanged,
  };
}

interface SheetTargetSettingRow {
  key: string;
  value: string;
}

async function lockExpectedPreviousSheetTarget(
  tx: Prisma.TransactionClient,
  expected: SheetTarget | null
): Promise<void> {
  const rows = await tx.$queryRaw<SheetTargetSettingRow[]>(
    Prisma.sql`
      SELECT "key", "value"
      FROM "Setting"
      WHERE "key" IN (
        ${SHEETS_SPREADSHEET_ID_SETTING},
        ${SHEETS_TAB_SETTING}
      )
      ORDER BY "key"
      FOR UPDATE
    `
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  let actual: SheetTarget | null;
  try {
    actual = configuredSheetTargetFromValues(
      values.get(SHEETS_SPREADSHEET_ID_SETTING),
      values.get(SHEETS_TAB_SETTING)
    );
  } catch {
    throw new SheetTargetCompareAndSetError(expected, null);
  }
  assertExpectedPreviousSheetTarget(expected, actual);
}

async function compareAndSetSheetTarget(
  tx: Prisma.TransactionClient,
  expected: SheetTarget | null,
  target: SheetTarget
): Promise<void> {
  if (expected === null) {
    const created = await tx.setting.createMany({
      data: [
        {
          key: SHEETS_SPREADSHEET_ID_SETTING,
          value: target.spreadsheetId,
        },
        { key: SHEETS_TAB_SETTING, value: target.tabName },
      ],
    });
    if (created.count !== 2) {
      throw new SheetTargetCompareAndSetError(expected, null);
    }
    return;
  }

  const spreadsheet = await tx.setting.updateMany({
    where: {
      key: SHEETS_SPREADSHEET_ID_SETTING,
      value: expected.spreadsheetId,
    },
    data: { value: target.spreadsheetId },
  });
  const tab = await tx.setting.updateMany({
    where: {
      key: SHEETS_TAB_SETTING,
      value: expected.tabName,
    },
    data: { value: target.tabName },
  });
  if (spreadsheet.count !== 1 || tab.count !== 1) {
    throw new SheetTargetCompareAndSetError(expected, null);
  }
}

interface SheetReconciliationContext {
  configuredTarget: SheetTarget | null;
}

async function syncContactsAtTarget(
  target: SheetTarget,
  deadline?: OperationDeadline,
  progress: SheetSyncProgress = {
    phase: "lease_acquisition",
    sheetMutationStarted: false,
    databaseMutationStarted: false,
  },
  context?: SheetReconciliationContext
): Promise<SheetSyncResult> {
  const configuredTarget = context
    ? context.configuredTarget
    : await getConfiguredSheetTarget();
  const targetChanged =
    configuredTarget !== null && !sameSheetTarget(configuredTarget, target);
  const allowLegacyOwnership = configuredTarget === null || !targetChanged;
  progress.phase = "lease_acquisition";
  if (deadline) {
    assertOperationTimeRemaining(
      deadline,
      SHEET_POST_LEASE_MIN_REMAINING_MS,
      "Acquire Sheets sync lease"
    );
  }
  return withSheetConfigurationLease(
    async (configurationLease) => {
      progress.phase = "target_compare_and_set_preflight";
      await configurationLease.assertOwned();
      assertExpectedPreviousSheetTarget(
        configuredTarget,
        await getConfiguredSheetTarget()
      );
      progress.phase = "tab_lease_acquisition";
      return withSheetSyncLease(
        target.spreadsheetId,
        target.tabName,
        async (lease) => {
    await configurationLease.assertOwned();
    progress.phase = "initial_sheet_read";
    const initialSheet = await readRawSheet(
      target,
      deadline,
      SHEET_PRE_WRITE_MIN_REMAINING_MS
    );
    await ensureStableRowIds(initialSheet, deadline, progress);
    await lease.assertOwned();
    progress.phase = "stable_row_identity_verification";
    const identified = requireStableRowIds(
      await readRawSheet(
        target,
        deadline,
        SHEET_DATABASE_MIN_REMAINING_MS
      )
    );
    const parsed = contactRows(identified);
    for (const row of parsed.rows) {
      const normalized = normalizeArtistName(row.artistName);
      if (!normalized) {
        throw new Error(`Invalid Sheet artist name: ${row.artistName}`);
      }
    }
    const now = new Date();
    const ownershipPrefixes = sourcePrefixes(target, allowLegacyOwnership);
    const incomingEmails = Array.from(
      new Set(parsed.rows.flatMap((row) => row.emails))
    );

    await configurationLease.assertOwned();
    await lease.assertOwned();
    progress.phase = "database_reconciliation";
    const transactionTiming = sheetDatabaseTransactionTiming(deadline);
    return db.$transaction(
      async (tx) => {
      const statementTimeout = `${transactionTiming.statementTimeoutMs}ms`;
      await tx.$queryRaw(
        Prisma.sql`
          SELECT set_config('statement_timeout', ${statementTimeout}, true)
        `
      );
      await configurationLease.fenceTransaction(tx);
      await lease.fenceTransaction(tx);
      await lockExpectedPreviousSheetTarget(tx, configuredTarget);
      await acquireArtistIdentityLock(tx);
      progress.databaseMutationStarted = true;
      const quarantined = await tx.contact.updateMany({
        where: {
          source: "sheet",
          sourceKey: null,
          state: "active",
        },
        data: { state: "quarantined" },
      });
      const ownershipContacts = await tx.contact.findMany({
        where: {
          OR: [
            ...ownershipPrefixes.map((prefix) => ({
              sourceKey: { startsWith: prefix },
            })),
            ...(incomingEmails.length > 0
              ? [
                  {
                    email: {
                      in: incomingEmails,
                      mode: "insensitive",
                    },
                  } satisfies Prisma.ContactWhereInput,
                ]
              : []),
          ],
        },
        include: { artist: true },
      });
      const artistByRow = new Map<string, Artist>();
      for (const contact of ownershipContacts) {
        if (!contact.sourceKey) continue;
        const source = parseSheetSourceKey(contact.sourceKey);
        if (
          !source ||
          !sheetSourceKeyBelongsToTarget(
            contact.sourceKey,
            target,
            allowLegacyOwnership
          )
        ) {
          continue;
        }
        const prior = artistByRow.get(source.rowId);
        if (prior && prior.id !== contact.artist.id) {
          throw new Error(
            `Sheet row ${source.rowId} is linked to multiple artists`
          );
        }
        artistByRow.set(source.rowId, contact.artist);
      }

      const adoptedLegacyContactIds = new Set<string>();
      for (const row of parsed.rows) {
        const adoption = selectLegacySheetRowAdoption(
          normalizeArtistName(row.artistName),
          row.emails,
          ownershipContacts
        );
        if (adoption.kind === "ambiguous") {
          throw new Error(
            `Legacy Sheet ownership is ambiguous for row ${row.rowId}: ${adoption.artistIds.join(", ")}`
          );
        }
        if (adoption.kind === "none") continue;
        const adoptedArtist = ownershipContacts.find(
          (contact) => contact.artist.id === adoption.artistId
        )?.artist;
        if (!adoptedArtist) {
          throw new Error(`Legacy Sheet artist disappeared: ${adoption.artistId}`);
        }
        const owned = artistByRow.get(row.rowId);
        if (owned && owned.id !== adoptedArtist.id) {
          throw new Error(
            `Sheet row ${row.rowId} has conflicting current and legacy ownership`
          );
        }
        artistByRow.set(row.rowId, adoptedArtist);
        for (const contactId of adoption.contactIds) {
          adoptedLegacyContactIds.add(contactId);
        }
      }

      for (const row of parsed.rows) {
        const owned = artistByRow.get(row.rowId);
        if (
          owned &&
          owned.normalizedName !== normalizeArtistName(row.artistName)
        ) {
          throw new Error(
            `Sheet row ${row.rowId} changed artists; clear its ${SHEET_SOURCE_ID_HEADER} cell to create a new source identity`
          );
        }
      }

      const unresolvedIdentities: ArtistIdentityInput[] = parsed.rows
        .filter((row) => !artistByRow.has(row.rowId))
        .map((row) => ({
          key: row.rowId,
          name: row.artistName,
          updateName: false,
        }));
      const resolved = await resolveArtists(tx, unresolvedIdentities);
      if (resolved.conflicts.length > 0) {
        throw new Error(
          `Sheet artist identity conflicts remain for tab "${target.tabName}"`
        );
      }
      for (const [rowId, artist] of resolved.artistsByKey) {
        artistByRow.set(rowId, artist);
      }

      const artistIds = Array.from(
        new Set(Array.from(artistByRow.values(), (artist) => artist.id))
      );
      const contacts = await tx.contact.findMany({
        where: {
          OR: [
            ...ownershipPrefixes.map((prefix) => ({
              sourceKey: { startsWith: prefix },
            })),
            ...(artistIds.length > 0 && incomingEmails.length > 0
              ? [
                  {
                    artistId: { in: artistIds },
                    email: {
                      in: incomingEmails,
                      mode: "insensitive",
                    },
                  } satisfies Prisma.ContactWhereInput,
                ]
              : []),
          ],
        },
        include: {
          _count: { select: { auditJobs: true } },
          auditJobs: {
            where: {
              OR: [
                {
                  resolution: { not: null },
                },
                {
                  resolution: null,
                  resolutionClaimToken: { not: null },
                  resolutionClaimedAt: {
                    gt: new Date(
                      now.getTime() -
                        CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS
                    ),
                  },
                },
              ],
            },
            select: {
              resolution: true,
              finding: true,
              resolvedEmail: true,
              resolvedDirectOutreachNote: true,
              resolutionClaimToken: true,
            },
          },
        },
      });
      if (
        contacts.some((contact) =>
          contact.auditJobs.some((job) => job.resolutionClaimToken)
        )
      ) {
        throw new Error(
          "A contact audit decision is currently updating a Sheet-owned contact; retry the Sheet sync"
        );
      }
      const bySourceKey = new Map(
        contacts
          .filter((contact) => contact.sourceKey)
          .map((contact) => [contact.sourceKey!, contact])
      );
      const contactsById = new Map(
        contacts.map((contact) => [contact.id, contact])
      );
      const byArtistEmail = new Map<string, (typeof contacts)[number]>(
        contacts.flatMap((contact) => {
          const email = normalizeEmail(contact.email ?? "");
          return email
            ? [[`${contact.artistId}\u0000${email}`, contact] as const]
            : [];
        })
      );
      const existingByRow = new Map<string, ExistingSheetContactSlot[]>();
      for (const contact of contacts) {
        if (!contact.sourceKey) continue;
        const parsedKey = parseSheetSourceKey(contact.sourceKey);
        if (
          !parsedKey ||
          !sheetSourceKeyBelongsToTarget(
            contact.sourceKey,
            target,
            allowLegacyOwnership
          )
        ) {
          continue;
        }
        const values = existingByRow.get(parsedKey.rowId) ?? [];
        values.push({
          sourceKey: contact.sourceKey,
          slot: parsedKey.slot,
          email: contact.email,
        });
        existingByRow.set(parsedKey.rowId, values);
      }

      const plans: Array<{
        sourceKey: string;
        existingId: string | null;
        artistId: string;
        email: string | null;
        directOutreachNote: string | null;
        row: ContactSheetRow;
      }> = [];
      const seenSourceKeys = new Set<string>();
      const claimedContactIds = new Set<string>();
      const plannedArtistEmails = new Set<string>();
      for (const row of parsed.rows) {
        const artist = artistByRow.get(row.rowId);
        if (!artist) throw new Error(`Sheet artist was not resolved: ${row.artistName}`);
        const reconciled = reconcileSheetContactSlots(
          target,
          row.rowId,
          existingByRow.get(row.rowId) ?? [],
          {
            emails: row.emails,
            directOutreachNote: row.directOutreachNote,
          }
        );
        for (const assignment of reconciled.assignments) {
          if (seenSourceKeys.has(assignment.sourceKey)) {
            throw new Error(`Duplicate Sheet source identity: ${assignment.sourceKey}`);
          }
          seenSourceKeys.add(assignment.sourceKey);
          const artistEmail = assignment.email
            ? `${artist.id}\u0000${assignment.email}`
            : null;
          if (artistEmail) {
            if (plannedArtistEmails.has(artistEmail)) {
              console.warn(
                JSON.stringify({
                  event: "sheet_contact_duplicate_skipped",
                  tabName: target.tabName,
                  rowId: row.rowId,
                  artistId: artist.id,
                  reason: "same_artist_email",
                })
              );
              continue;
            }
            plannedArtistEmails.add(artistEmail);
          }

          const sourceContact = bySourceKey.get(
            assignment.priorSourceKey ?? assignment.sourceKey
          );
          const exactContact = artistEmail
            ? byArtistEmail.get(artistEmail)
            : undefined;
          if (
            exactContact?.source === "sheet" &&
            exactContact.sourceKey === null &&
            !adoptedLegacyContactIds.has(exactContact.id)
          ) {
            throw new Error(
              `Legacy Sheet contact ${assignment.email} cannot be assigned to this row unambiguously`
            );
          }
          if (sourceContact && sourceContact.artistId !== artist.id) {
            throw new Error(
              `Sheet row ${row.rowId} changed artists; clear its ${SHEET_SOURCE_ID_HEADER} cell to create a new source identity`
            );
          }
          if (
            sourceContact &&
            exactContact &&
            sourceContact.id !== exactContact.id
          ) {
            throw new Error(
              `Cannot replace ${sourceContact.email ?? "contact"} with ${
                assignment.email
              }; that address already exists`
            );
          }
          const existingContact = sourceContact ?? exactContact ?? null;
          if (existingContact?.sourceKey) {
            const migratesCurrentOwnership =
              existingContact.sourceKey === assignment.sourceKey ||
              existingContact.sourceKey === assignment.priorSourceKey;
            const transfersPreviousOwnership =
              targetChanged &&
              configuredTarget !== null &&
              sheetSourceKeyBelongsToTarget(
                existingContact.sourceKey,
                configuredTarget,
                true
              );
            if (!migratesCurrentOwnership && !transfersPreviousOwnership) {
              throw new Error(
                `Sheet contact ${
                  assignment.email ?? assignment.directOutreachNote
                } is owned by another row or spreadsheet`
              );
            }
          }
          if (existingContact) claimedContactIds.add(existingContact.id);
          plans.push({
            sourceKey: assignment.sourceKey,
            existingId: existingContact?.id ?? null,
            artistId: artist.id,
            email: assignment.email,
            directOutreachNote: assignment.directOutreachNote,
            row,
          });
        }
      }

      const staleIds = staleOwnedSheetContactIds(
        target,
        allowLegacyOwnership,
        contacts.map((contact) => ({
          id: contact.id,
          sourceKey: contact.sourceKey,
          preserveAuditHistory:
            contact.state === "quarantined" &&
            contact._count.auditJobs > 0,
        })),
        claimedContactIds,
        seenSourceKeys
      );
      const deleted =
        staleIds.length > 0
          ? await tx.contact.deleteMany({ where: { id: { in: staleIds } } })
          : { count: 0 };

      const createRows = plans
        .filter((plan) => !plan.existingId)
        .map((plan) => ({
          ...sheetOwnedContactData(plan, now),
          state: "active" as const,
        }));
      if (createRows.length > 0) {
        await tx.contact.createMany({ data: createRows });
      }
      for (const updateChunk of chunkItems(
        plans.filter((plan) => plan.existingId),
        100
      )) {
        await Promise.all(
          updateChunk.map((plan) =>
            tx.contact.update({
              where: { id: plan.existingId! },
              data: {
                ...sheetOwnedContactData(plan, now),
                state: shouldKeepApprovedStaleSheetContactQuarantined(
                  contactsById.get(plan.existingId!)!,
                  plan
                )
                  ? "quarantined"
                  : "active",
              },
            })
          )
        );
      }

      const remainingLegacyContacts =
        incomingEmails.length > 0
          ? await tx.contact.findMany({
              where: {
                source: "sheet",
                sourceKey: null,
                state: "quarantined",
                email: {
                  in: incomingEmails,
                  mode: "insensitive",
                },
              },
              include: { artist: true },
            })
          : [];
      const remainingAdoptions = remainingLegacySheetAdoptions(
        parsed.rows,
        remainingLegacyContacts
      );
      if (remainingAdoptions.conflicts.length > 0) {
        throw new Error(
          `Legacy Sheet ownership conflicts remain for tab "${target.tabName}"`
        );
      }
      if (remainingAdoptions.contactIds.length > 0) {
        throw new Error(
          `Sheet adoption verification failed for tab "${target.tabName}": ${remainingAdoptions.contactIds.length} adoptable legacy contact(s) remain quarantined`
        );
      }

      let previousTargetQuarantined = 0;
      if (targetChanged && configuredTarget) {
        const previousOwnership = await tx.contact.findMany({
          where: {
            source: "sheet",
            OR: sourcePrefixes(configuredTarget, true).map((prefix) => ({
              sourceKey: { startsWith: prefix },
            })),
          },
          select: { id: true, sourceKey: true },
        });
        const existingSourceKeys = new Map(
          previousOwnership
            .filter((contact) => contact.sourceKey)
            .map((contact) => [contact.sourceKey!, contact.id])
        );
        const previousPlans = previousOwnership.flatMap((contact) => {
          if (
            contact.sourceKey === null ||
            !sheetSourceKeyBelongsToTarget(
              contact.sourceKey,
              configuredTarget,
              true
            )
          ) {
            return [];
          }
          const parsed = parseSheetSourceKey(contact.sourceKey);
          if (!parsed) return [];
          const explicitSourceKey =
            parsed.spreadsheetId === null
              ? makeSheetSourceKey(
                  configuredTarget,
                  parsed.rowId,
                  parsed.slot
                )
              : contact.sourceKey;
          const existingOwner = existingSourceKeys.get(explicitSourceKey);
          if (existingOwner && existingOwner !== contact.id) {
            throw new Error(
              "Legacy Sheet ownership conflicts with an explicit previous-target identity"
            );
          }
          existingSourceKeys.set(explicitSourceKey, contact.id);
          return [{ id: contact.id, sourceKey: explicitSourceKey }];
        });
        for (const planChunk of chunkItems(previousPlans, 100)) {
          await Promise.all(
            planChunk.map((plan) =>
              tx.contact.update({
                where: { id: plan.id },
                data: {
                  sourceKey: plan.sourceKey,
                  state: "quarantined",
                },
              })
            )
          );
        }
        previousTargetQuarantined = previousPlans.length;
      }

      await compareAndSetSheetTarget(tx, configuredTarget, target);
      await tx.setting.upsert({
        where: { key: "sheets_last_sync" },
        create: { key: "sheets_last_sync", value: now.toISOString() },
        update: { value: now.toISOString() },
      });
      return {
        tabName: target.tabName,
        read: identified.rows.length,
        contactsUpserted: plans.length,
        contactsDeleted: deleted.count,
        contactsQuarantined:
          quarantined.count + previousTargetQuarantined,
        legacyContactsAdopted: adoptedLegacyContactIds.size,
        adoptionVerified: true,
        artistsCreated: resolved.created,
        skipped: parsed.skipped,
        rowsIdentified: parsed.rows.length,
        identityConflicts: resolved.conflicts,
      };
      },
      {
        maxWait: transactionTiming.maxWait,
        timeout: transactionTiming.timeout,
      }
    );
        },
        deadline
      );
    },
    deadline
  );
}

export interface AppendContactInput {
  artistName: string;
  email: string;
  managerName?: string | null;
  role?: string | null;
  customPrice?: string | null;
  notes?: string | null;
}

function setColumn(
  row: string[],
  header: readonly string[],
  names: readonly string[],
  value: string | null | undefined
) {
  if (value == null) return;
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0) row[index] = value;
  }
}

async function appendContactRow(
  sheet: IdentifiedSheet,
  data: AppendContactInput,
  contactCellValue: string
): Promise<string> {
  const rowId = randomUUID();
  const row = new Array<string>(sheet.header.length).fill("");
  setColumn(row, sheet.header, ["artist", "artist name"], data.artistName);
  setColumn(row, sheet.header, ["manager_name", "manager name"], data.managerName);
  setColumn(row, sheet.header, ["email"], contactCellValue);
  setColumn(row, sheet.header, ["price", "rate"], data.customPrice);
  setColumn(row, sheet.header, ["role"], data.role);
  setColumn(row, sheet.header, ["notes"], data.notes);
  row[sheet.sourceIdColumn] = rowId;

  await sheet.sheets.spreadsheets.values.append({
    spreadsheetId: sheet.spreadsheetId,
    range: `${quoteTab(sheet.tabName)}!A:ZZ`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  return rowId;
}

export async function appendContactToSheet(
  data: AppendContactInput
): Promise<{ sourceKey: string }> {
  const parsedEmail = parseSheetEmails(data.email);
  if (parsedEmail.emails.length !== 1) {
    throw new Error("A Sheet contact row must contain exactly one email");
  }
  const target = await targetForSheetMutation();
  return withSheetSyncLease(
    target.spreadsheetId,
    target.tabName,
    async (lease) => {
    await ensureStableRowIds(await readRawSheet(target));
    await lease.assertOwned();
    const sheet = requireStableRowIds(await readRawSheet(target));
    const rowId = await appendContactRow(sheet, data, parsedEmail.emails[0]);
    await lease.assertOwned();
    const finalSheet = requireStableRowIds(await readRawSheet(target));
    if (
      !finalSheet.rows.some(
        (row) => (row[finalSheet.sourceIdColumn] ?? "").trim() === rowId
      )
    ) {
      throw new Error("The appended Sheet row did not persist its stable identity");
    }
    return { sourceKey: makeSheetSourceKey(target, rowId, 0) };
    }
  );
}

export interface UpdateContactInput {
  artistName: string;
  oldEmail?: string | null;
  newEmail?: string | null;
  oldDirectOutreachNote?: string | null;
  newDirectOutreachNote?: string | null;
  sourceKey?: string | null;
  managerName?: string | null;
  role?: string | null;
  customPrice?: string | null;
  notes?: string | null;
}

export interface UpdateAuditedContactInput {
  artistName: string;
  oldEmail?: string | null;
  newEmail?: string | null;
  oldDirectOutreachNote?: string | null;
  newDirectOutreachNote?: string | null;
  sourceKey: string;
  managerName?: string | null;
  role?: string | null;
}

export interface ContactSheetCellUpdate {
  columnIndex: number;
  value: string;
  range: string;
  values: [[string]];
}

export interface ContactSheetCellUpdatePlanInput {
  tabName: string;
  sheetRow: number;
  header: readonly string[];
  existing: readonly string[];
  contactCellValue: string | null;
  managerName: string;
  role: string;
  customPrice: string | null;
  notes: string | null;
}

export function planContactSheetCellUpdates(
  input: ContactSheetCellUpdatePlanInput
): ContactSheetCellUpdate[] {
  if (!Number.isInteger(input.sheetRow) || input.sheetRow < 2) {
    throw new Error("Invalid Sheet row number");
  }
  const updates: ContactSheetCellUpdate[] = [];
  const scheduled = new Set<number>();
  const schedule = (names: readonly string[], value: string | null) => {
    if (value === null) return;
    for (const name of names) {
      const columnIndex = input.header.indexOf(name);
      if (
        columnIndex < 0 ||
        scheduled.has(columnIndex) ||
        (input.existing[columnIndex] ?? "") === value
      ) {
        continue;
      }
      scheduled.add(columnIndex);
      updates.push({
        columnIndex,
        value,
        range: `${quoteTab(input.tabName)}!${colNumToLetter(
          columnIndex + 1
        )}${input.sheetRow}`,
        values: [[value]],
      });
    }
  };

  schedule(["email"], input.contactCellValue);
  schedule(["manager_name", "manager name"], input.managerName);
  schedule(["price", "rate"], input.customPrice);
  schedule(["role"], input.role);
  schedule(["notes"], input.notes);
  return updates.sort((left, right) => left.columnIndex - right.columnIndex);
}

export function planAuditedContactSheetCellUpdates(
  input: Omit<ContactSheetCellUpdatePlanInput, "customPrice" | "notes">
): ContactSheetCellUpdate[] {
  return planContactSheetCellUpdates({
    ...input,
    customPrice: null,
    notes: null,
  });
}

export interface AuditedContactSheetRollback {
  sourceKey: string;
  rowId: string;
  cells: Array<{
    columnIndex: number;
    before: string;
    after: string;
  }>;
}

export class AuditedContactSheetPostWriteError extends Error {
  readonly rollback: AuditedContactSheetRollback;
  readonly originalError: unknown;

  constructor(
    originalError: unknown,
    rollback: AuditedContactSheetRollback
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : String(originalError)
    );
    this.name = "AuditedContactSheetPostWriteError";
    this.rollback = rollback;
    this.originalError = originalError;
  }
}

export async function verifyAuditedContactSheetPostWrite(
  rollback: AuditedContactSheetRollback,
  verify: () => Promise<void>
): Promise<void> {
  try {
    await verify();
  } catch (error) {
    throw new AuditedContactSheetPostWriteError(error, rollback);
  }
}

export function captureAuditedContactSheetRollbackCells(
  existing: readonly string[],
  updates: readonly ContactSheetCellUpdate[]
): AuditedContactSheetRollback["cells"] {
  return updates.map((update) => ({
    columnIndex: update.columnIndex,
    before: existing[update.columnIndex] ?? "",
    after: update.value,
  }));
}

export interface SheetContactUpdateResult {
  updated: boolean;
  rowIndex: number | null;
  sourceKey: string;
}

export interface AuditedContactSheetUpdateResult
  extends SheetContactUpdateResult {
  rollback: AuditedContactSheetRollback;
}

type SheetManagedContactTarget =
  | { kind: "email"; email: string; cellValue: string }
  | {
      kind: "direct_outreach";
      directOutreachNote: string;
      cellValue: string;
    };

function sheetManagedContactTarget(
  emailValue: string | null | undefined,
  directOutreachNote: string | null | undefined,
  label: "existing" | "updated"
): SheetManagedContactTarget {
  const rawEmail = emailValue?.trim() ?? "";
  const note = directOutreachNote?.trim() ?? "";
  const parsed = rawEmail ? parseSheetEmails(rawEmail).emails : [];
  if (rawEmail && parsed.length !== 1) {
    throw new Error(`The ${label} Sheet contact must have exactly one email`);
  }
  if (parsed.length === 1 && note) {
    throw new Error(
      "A Sheet contact cannot mix email and direct outreach details"
    );
  }
  if (parsed.length === 1) {
    return { kind: "email", email: parsed[0], cellValue: parsed[0] };
  }
  if (note) {
    return {
      kind: "direct_outreach",
      directOutreachNote: note,
      cellValue: note,
    };
  }
  throw new Error(
    `The ${label} Sheet contact must have an email or direct outreach details`
  );
}

async function updateContactInSheetInternal(
  data: UpdateContactInput,
  auditOnly: boolean
): Promise<SheetContactUpdateResult | AuditedContactSheetUpdateResult> {
  const normalizedArtist = normalizeArtistName(data.artistName);
  const oldTarget = sheetManagedContactTarget(
    data.oldEmail,
    data.oldDirectOutreachNote,
    "existing"
  );
  const newTarget = sheetManagedContactTarget(
    data.newEmail,
    data.newDirectOutreachNote,
    "updated"
  );
  const target = await targetForSheetMutation(data.sourceKey);

  return withSheetSyncLease(
    target.spreadsheetId,
    target.tabName,
    async (lease) => {
    await ensureStableRowIds(await readRawSheet(target));
    await lease.assertOwned();
    const sheet = requireStableRowIds(await readRawSheet(target));
    const { artistColumn, emailColumn } = contactIdentityColumns(sheet);

    let matchIndex = -1;
    let matchedSourceKey: string | null = null;
    let matchedSourceSlot: number | null = null;
    if (data.sourceKey) {
      const source = parseSheetSourceKey(data.sourceKey);
      if (
        !source ||
        !sheetSourceKeyBelongsToTarget(data.sourceKey, target, true)
      ) {
        throw new Error("Contact has an invalid Sheet source identity");
      }
      matchedSourceSlot = source.slot;
      matchIndex = sheet.rows.findIndex(
        (row) => (row[sheet.sourceIdColumn] ?? "").trim() === source.rowId
      );
      if (matchIndex < 0) {
        throw new Error("The source Sheet row no longer exists");
      }
    } else {
      const candidates = sheet.rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
          if (
            normalizeArtistName((row[artistColumn] ?? "").trim()) !==
            normalizedArtist
          ) {
            return false;
          }
          const contactCell = (row[emailColumn] ?? "").trim();
          const emails = parseSheetEmails(contactCell).emails;
          if (oldTarget.kind === "email") {
            return (
              emails.includes(oldTarget.email) ||
              (newTarget.kind === "email" &&
                emails.includes(newTarget.email))
            );
          }
          return (
            emails.length === 0 &&
            (contactCell === oldTarget.directOutreachNote ||
              (newTarget.kind === "direct_outreach" &&
                contactCell === newTarget.directOutreachNote))
          );
        });
      if (candidates.length > 1) {
        throw new Error("Multiple Sheet rows match this contact");
      }
      matchIndex = candidates[0]?.index ?? -1;
    }

    if (matchIndex < 0) {
      if (auditOnly) {
        throw new Error("The audited source Sheet row no longer exists");
      }
      const rowId = await appendContactRow(
        sheet,
        {
          artistName: data.artistName,
          email: newTarget.kind === "email" ? newTarget.email : "",
          managerName: data.managerName,
          role: data.role,
          customPrice: data.customPrice,
          notes: data.notes,
        },
        newTarget.cellValue
      );
      await lease.assertOwned();
      const finalSheet = requireStableRowIds(await readRawSheet(target));
      if (
        !finalSheet.rows.some(
          (row) => (row[finalSheet.sourceIdColumn] ?? "").trim() === rowId
        )
      ) {
        throw new Error(
          "The appended Sheet row did not persist its stable identity"
        );
      }
      return {
        updated: false,
        rowIndex: null,
        sourceKey: makeSheetSourceKey(target, rowId, 0),
      };
    }

    const existing = sheet.rows[matchIndex];
    const existingCell = (existing[emailColumn] ?? "").trim();
    const parsedCell = parseSheetEmails(existingCell);
    const rowId = (existing[sheet.sourceIdColumn] ?? "").trim();
    if (!rowId) {
      throw new Error("The source Sheet row has no stable contact identity");
    }
    let identitySlot = matchedSourceSlot;
    let contactCellValue: string | null = null;

    if (oldTarget.kind === "email") {
      const oldEmailIndex = parsedCell.emails.indexOf(oldTarget.email);
      if (newTarget.kind === "email") {
        const newEmailIndex = parsedCell.emails.indexOf(newTarget.email);
        if (oldEmailIndex < 0 && newEmailIndex < 0) {
          throw new Error("The source Sheet row no longer contains the old email");
        }
        identitySlot ??=
          oldEmailIndex >= 0 ? oldEmailIndex : newEmailIndex;
        if (
          oldEmailIndex >= 0 &&
          newTarget.email !== oldTarget.email
        ) {
          if (newEmailIndex >= 0) {
            parsedCell.emails.splice(oldEmailIndex, 1);
          } else {
            parsedCell.emails[oldEmailIndex] = newTarget.email;
          }
          contactCellValue = composeSheetEmails(
            parsedCell.emails,
            parsedCell.isFullTeam
          );
        }
      } else {
        if (oldEmailIndex < 0) {
          throw new Error("The source Sheet row no longer contains the old email");
        }
        if (parsedCell.emails.length !== 1) {
          throw new Error(
            "A shared multi-email Sheet row cannot be converted to direct outreach"
          );
        }
        identitySlot = 0;
        if (existingCell !== newTarget.directOutreachNote) {
          contactCellValue = newTarget.directOutreachNote;
        }
      }
    } else {
      if (
        parsedCell.emails.length > 0 ||
        existingCell !== oldTarget.directOutreachNote
      ) {
        throw new Error(
          "The source Sheet row no longer contains the direct outreach details"
        );
      }
      identitySlot = 0;
      if (existingCell !== newTarget.cellValue) {
        contactCellValue = newTarget.cellValue;
      }
    }

    if (identitySlot === null || identitySlot < 0) {
      throw new Error("The source Sheet row has no stable contact identity");
    }
    matchedSourceKey = makeSheetSourceKey(target, rowId, identitySlot);

    const sheetRow = matchIndex + 2;
    const commonPlan = {
      tabName: target.tabName,
      sheetRow,
      header: sheet.header,
      existing,
      contactCellValue,
      managerName: data.managerName ?? "",
      role: data.role ?? "",
    };
    const updates = auditOnly
      ? planAuditedContactSheetCellUpdates(commonPlan)
      : planContactSheetCellUpdates({
          ...commonPlan,
          customPrice: data.customPrice ?? "",
          notes: data.notes ?? "",
        });
    const auditRollback = auditOnly
      ? {
          sourceKey: matchedSourceKey,
          rowId,
          cells: captureAuditedContactSheetRollbackCells(existing, updates),
        }
      : null;
    let sheetWriteCompleted = false;
    if (updates.length > 0) {
      await sheet.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sheet.spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: updates.map(({ range, values }) => ({ range, values })),
        },
      });
      sheetWriteCompleted = true;
    }
    const verifyPostWrite = async () => {
      await lease.assertOwned();
      const finalSheet = requireStableRowIds(await readRawSheet(target));
      const finalRow = finalSheet.rows.find(
        (row) => (row[finalSheet.sourceIdColumn] ?? "").trim() === rowId
      );
      const finalContactCell = finalRow
        ? (finalRow[emailColumn] ?? "").trim()
        : "";
      const persistedEmails = finalRow
        ? parseSheetEmails(finalContactCell).emails
        : [];
      const updatedTargetPersisted =
        newTarget.kind === "email"
          ? persistedEmails.includes(newTarget.email)
          : persistedEmails.length === 0 &&
            finalContactCell === newTarget.directOutreachNote;
      const oldEmailRemoved =
        oldTarget.kind !== "email" ||
        (newTarget.kind === "email" &&
          newTarget.email === oldTarget.email) ||
        !persistedEmails.includes(oldTarget.email);
      if (
        !finalRow ||
        updates.some(
          (update) => (finalRow[update.columnIndex] ?? "") !== update.value
        ) ||
        !updatedTargetPersisted ||
        !oldEmailRemoved
      ) {
        throw new Error("The Sheet contact update could not be verified");
      }
    };
    if (auditRollback && sheetWriteCompleted) {
      await verifyAuditedContactSheetPostWrite(
        auditRollback,
        verifyPostWrite
      );
    } else {
      await verifyPostWrite();
    }
    const result: SheetContactUpdateResult = {
      updated: true,
      rowIndex: sheetRow,
      sourceKey: matchedSourceKey,
    };
    if (!auditOnly) return result;
    return {
      ...result,
      rollback: auditRollback!,
    };
    }
  );
}

export async function updateContactInSheet(
  data: UpdateContactInput
): Promise<SheetContactUpdateResult> {
  return updateContactInSheetInternal(
    data,
    false
  ) as Promise<SheetContactUpdateResult>;
}

export async function updateAuditedContactInSheet(
  data: UpdateAuditedContactInput
): Promise<AuditedContactSheetUpdateResult> {
  return updateContactInSheetInternal(
    data,
    true
  ) as Promise<AuditedContactSheetUpdateResult>;
}

export async function rollbackAuditedContactInSheet(
  rollback: AuditedContactSheetRollback
): Promise<void> {
  const target = await targetForSheetMutation(rollback.sourceKey);
  return withSheetSyncLease(
    target.spreadsheetId,
    target.tabName,
    async (lease) => {
      await ensureStableRowIds(await readRawSheet(target));
      await lease.assertOwned();
      const sheet = requireStableRowIds(await readRawSheet(target));
      const source = parseSheetSourceKey(rollback.sourceKey);
      if (
        !source ||
        source.rowId !== rollback.rowId ||
        !sheetSourceKeyBelongsToTarget(rollback.sourceKey, target, true)
      ) {
        throw new Error("Audit Sheet rollback has an invalid source identity");
      }
      const rowIndex = sheet.rows.findIndex(
        (row) => (row[sheet.sourceIdColumn] ?? "").trim() === rollback.rowId
      );
      if (rowIndex < 0) {
        throw new Error("The audited source Sheet row no longer exists");
      }
      const row = sheet.rows[rowIndex];
      if (
        rollback.cells.some(
          (cell) => (row[cell.columnIndex] ?? "") !== cell.after
        )
      ) {
        throw new Error(
          "The audited Sheet fields changed after approval; rollback was not applied"
        );
      }

      if (rollback.cells.length > 0) {
        await sheet.sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheet.spreadsheetId,
          requestBody: {
            valueInputOption: "RAW",
            data: rollback.cells.map((cell) => ({
              range: `${quoteTab(target.tabName)}!${colNumToLetter(
                cell.columnIndex + 1
              )}${rowIndex + 2}`,
              values: [[cell.before]],
            })),
          },
        });
      }
      await lease.assertOwned();
      const finalSheet = requireStableRowIds(await readRawSheet(target));
      const finalRow = finalSheet.rows.find(
        (candidate) =>
          (candidate[finalSheet.sourceIdColumn] ?? "").trim() ===
          rollback.rowId
      );
      if (
        !finalRow ||
        rollback.cells.some(
          (cell) => (finalRow[cell.columnIndex] ?? "") !== cell.before
        )
      ) {
        throw new Error("The audited Sheet rollback could not be verified");
      }
    }
  );
}

export async function recoverAuditedContactSheetPostWriteError(
  error: AuditedContactSheetPostWriteError,
  rollback: (
    token: AuditedContactSheetRollback
  ) => Promise<void> = rollbackAuditedContactInSheet
): Promise<{ rolledBack: true } | { rolledBack: false; rollbackError: string }> {
  try {
    await rollback(error.rollback);
    return { rolledBack: true };
  } catch (rollbackFailure) {
    return {
      rolledBack: false,
      rollbackError:
        rollbackFailure instanceof Error
          ? rollbackFailure.message
          : String(rollbackFailure),
    };
  }
}
