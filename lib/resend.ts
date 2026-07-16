import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Prisma } from "@prisma/client";
import { Resend, type ErrorResponse } from "resend";
import { db } from "@/lib/db";
import { readGeneralDeliverySettingsInTransaction } from "@/lib/generalSettings";

export const RESEND_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RATE_CARD_MISSING_WARNING =
  "Configured rate card attachment was not found and was omitted";
export const RESEND_CONFIGURATION_ERROR =
  "Resend is unavailable because RESEND_API_KEY is missing or blank";
export const RESEND_FROM_EMAIL_CONFIGURATION_ERROR =
  "Resend is unavailable because RESEND_FROM_EMAIL is missing or blank";
export const RESEND_FROM_EMAIL_INVALID_CONFIGURATION_ERROR =
  "Resend is unavailable because RESEND_FROM_EMAIL must be an email address or Name <email@example.com>";
export const RESEND_FULL_CONFIGURATION_ERROR =
  "Resend is unavailable because RESEND_API_KEY and RESEND_FROM_EMAIL are missing or blank";
export const RESEND_PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
export const RATE_CARD_REQUEST_TIMEOUT_MS = 20_000;
export const RESEND_CREDENTIAL_SCOPE_PREFIX = "resend:key-sha256:";

let _client: Resend | null = null;
let _clientApiKey: string | null = null;

class DeadlineResend extends Resend {
  override fetchRequest<T>(path: string, options = {}) {
    const requestOptions = options as RequestInit;
    const deadlineSignal = AbortSignal.timeout(
      RESEND_PROVIDER_REQUEST_TIMEOUT_MS,
    );
    const signal = requestOptions.signal
      ? AbortSignal.any([requestOptions.signal, deadlineSignal])
      : deadlineSignal;
    return super.fetchRequest<T>(path, { ...requestOptions, signal });
  }
}

export function getResendConfigurationError(
  apiKey: string | undefined,
  fromEmail: string | undefined,
): string | null {
  const hasApiKey = Boolean(apiKey?.trim());
  const hasFromEmail = Boolean(fromEmail?.trim());
  if (!hasApiKey && !hasFromEmail) return RESEND_FULL_CONFIGURATION_ERROR;
  if (!hasApiKey) return RESEND_CONFIGURATION_ERROR;
  if (!hasFromEmail) return RESEND_FROM_EMAIL_CONFIGURATION_ERROR;
  if (!isValidResendSender(fromEmail)) {
    return RESEND_FROM_EMAIL_INVALID_CONFIGURATION_ERROR;
  }
  return null;
}

function client(key: string): Resend {
  if (_client && _clientApiKey === key) return _client;
  _client = new DeadlineResend(key);
  _clientApiKey = key;
  return _client;
}

export function getResendCredentialScope(
  apiKey: string | undefined,
): string | null {
  const key = apiKey?.trim();
  if (!key) return null;
  const fingerprint = createHash("sha256")
    .update("photo-admin/resend-credential-scope/v1\0")
    .update(key)
    .digest("hex");
  return `${RESEND_CREDENTIAL_SCOPE_PREFIX}${fingerprint}`;
}

export interface ResendSubmissionCredential {
  apiKey: string;
  scope: string;
}

export function getResendSubmissionCredential(
  apiKey: string | undefined = process.env.RESEND_API_KEY,
): ResendSubmissionCredential | null {
  const key = apiKey?.trim();
  const scope = getResendCredentialScope(key);
  return key && scope ? { apiKey: key, scope } : null;
}

export interface ResendAttachmentSnapshot {
  filename: string;
  contentSha256: string;
  byteLength: number;
  contentType: string | null;
  contentId: string | null;
}

export interface ResendAttachmentBlob {
  sha256: string;
  content: Uint8Array<ArrayBuffer>;
  byteLength: number;
}

export interface ResendRequestSnapshot {
  version: 1;
  idempotencyKey: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string;
  headers: Record<string, string>;
  tags: { name: string; value: string }[];
  attachments: ResendAttachmentSnapshot[];
}

export interface PrepareResendRequestArgs {
  to: string[];
  subject: string;
  html: string;
  outreachId: string;
  attemptId: string;
  idempotencyKey: string;
}

export type ResendPreparationDisposition = "retryable" | "permanent";

export type PrepareResendRequestResult =
  | {
      ok: true;
      request: ResendRequestSnapshot;
      requestHash: string;
      testSend: boolean;
      attachmentBlobs: ResendAttachmentBlob[];
      warnings: string[];
      rateCardAttachmentOmitted: boolean;
    }
  | {
      ok: false;
      error: string;
      preparationDisposition: ResendPreparationDisposition;
    };

export type ResendFailureDisposition =
  | "configuration"
  | "in_flight"
  | "retryable"
  | "permanent"
  | "uncertain"
  | "policy";

export interface SendResult {
  providerMessageId: string | null;
  error: string | null;
  failureDisposition: ResendFailureDisposition | null;
}

function normalizeMailboxAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export function normalizeEmail(value: string): string | null {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/<([^<>]+)>$/)?.[1] ?? trimmed;
  return normalizeMailboxAddress(bracketed);
}

export function isValidResendSender(value: string | undefined): boolean {
  const sender = value?.trim();
  if (!sender || /[\r\n,]/.test(sender)) return false;

  if (!sender.includes("<") && !sender.includes(">")) {
    return normalizeMailboxAddress(sender) !== null;
  }

  const displayAddress = sender.match(/^([^<>]+?)\s*<([^<>]+)>$/);
  if (!displayAddress || !displayAddress[1].trim()) return false;
  return normalizeMailboxAddress(displayAddress[2]) !== null;
}

export function normalizeEmails(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeEmail).filter((email): email is string => email !== null)),
  ).sort();
}

export async function excludeSuppressedEmails(values: string[]): Promise<string[]> {
  const normalized = normalizeEmails(values);
  if (normalized.length === 0) return [];
  const suppressed = await db.emailSuppression.findMany({
    where: { normalizedEmail: { in: normalized } },
    select: { normalizedEmail: true },
  });
  const blocked = new Set(suppressed.map((row) => row.normalizedEmail));
  return normalized.filter((email) => !blocked.has(email));
}

// Test override email: when set, every send is redirected here.
// DB setting wins over env (so the UI toggle is the source of truth).
// Empty DB value explicitly disables; missing DB entry falls back to env.
export function resolveTestOverrideSetting(
  setting: { value: string } | null,
  envValue: string | undefined = process.env.SEND_TEST_OVERRIDE,
): string | null {
  if (setting !== null) return setting.value.trim() || null;
  const env = envValue?.trim();
  return env || null;
}

export async function getTestOverride(): Promise<string | null> {
  const setting = await db.setting.findUnique({ where: { key: "test_override_email" } });
  return resolveTestOverrideSetting(setting);
}

// BCC addresses (comma-separated in DB). Copied on every real send.
export function parseBccEmails(value: string | null | undefined): string[] {
  return normalizeEmails((value ?? "").split(/[\s,;]+/));
}

export async function getBccEmails(): Promise<string[]> {
  const setting = await db.setting.findUnique({ where: { key: "bcc_emails" } });
  return parseBccEmails(setting?.value);
}

export interface ResendDeliverySettingsSnapshot {
  apiKey: string | undefined;
  credentialScope: string | null;
  from: string | undefined;
  testOverride: string | null;
  bccEmails: string[];
}

export async function getResendDeliverySettingsSnapshot(
  tx?: Prisma.TransactionClient,
): Promise<ResendDeliverySettingsSnapshot> {
  const readSnapshot = async (
    policyTx: Prisma.TransactionClient,
  ): Promise<ResendDeliverySettingsSnapshot> => {
    const settings = await readGeneralDeliverySettingsInTransaction(policyTx);
    const apiKey = process.env.RESEND_API_KEY;
    return {
      apiKey,
      credentialScope: getResendCredentialScope(apiKey),
      from: process.env.RESEND_FROM_EMAIL,
      testOverride: resolveTestOverrideSetting(
        settings.testOverrideValue === null
          ? null
          : { value: settings.testOverrideValue },
      ),
      bccEmails: parseBccEmails(settings.bccEmailsValue),
    };
  };
  return tx ? readSnapshot(tx) : db.$transaction(readSnapshot);
}

export interface AttachmentInfo {
  source: string;
  filename: string;
  kind: "url" | "file";
  exists: boolean;
}

export function getRateCardInfo(): AttachmentInfo | null {
  const source = process.env.RATE_CARD_PATH?.trim();
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    const filename = new URL(source).pathname.split("/").pop() || "rate-card.pdf";
    return { source, filename, kind: "url", exists: true };
  }
  return { source, filename: basename(source), kind: "file", exists: existsSync(source) };
}

export interface LoadedResendAttachments {
  snapshots: ResendAttachmentSnapshot[];
  blobs: ResendAttachmentBlob[];
  warnings: string[];
  rateCardAttachmentOmitted: boolean;
}

export interface RateCardAttachmentLoadDependencies {
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<Uint8Array>;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isTransientFileError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return new Set([
    "EAGAIN",
    "EBUSY",
    "EMFILE",
    "ENFILE",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
  ]).has(String((error as { code?: unknown }).code));
}

function isRetryableAttachmentStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class ResendPreparationError extends Error {
  readonly preparationDisposition: ResendPreparationDisposition;

  constructor(
    message: string,
    preparationDisposition: ResendPreparationDisposition,
  ) {
    super(message);
    this.name = "ResendPreparationError";
    this.preparationDisposition = preparationDisposition;
  }
}

export async function loadRateCardAttachments(
  info: AttachmentInfo | null | undefined = undefined,
  dependencies: RateCardAttachmentLoadDependencies = {},
): Promise<LoadedResendAttachments> {
  let resolvedInfo: AttachmentInfo | null = null;
  try {
    resolvedInfo = info === undefined ? getRateCardInfo() : info;
    if (!resolvedInfo) {
      return {
        snapshots: [],
        blobs: [],
        warnings: [],
        rateCardAttachmentOmitted: false,
      };
    }

    let content: Buffer;
    let contentType: string | null;
    if (resolvedInfo.kind === "url") {
      const response = await (dependencies.fetchImpl ?? fetch)(
        resolvedInfo.source,
        {
        cache: "no-store",
        signal: AbortSignal.timeout(RATE_CARD_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          return {
            snapshots: [],
            blobs: [],
            warnings: [RATE_CARD_MISSING_WARNING],
            rateCardAttachmentOmitted: true,
          };
        }
        throw new ResendPreparationError(
          `Unable to snapshot rate card attachment: Rate card request returned HTTP ${response.status}`,
          isRetryableAttachmentStatus(response.status)
            ? "retryable"
            : "permanent",
        );
      }
      content = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get("content-type");
    } else {
      try {
        const bytes = await (dependencies.readFileImpl ?? readFile)(
          resolvedInfo.source,
        );
        content = Buffer.from(bytes);
      } catch (error) {
        if (isMissingFileError(error)) {
          return {
            snapshots: [],
            blobs: [],
            warnings: [RATE_CARD_MISSING_WARNING],
            rateCardAttachmentOmitted: true,
          };
        }
        throw error;
      }
      contentType = null;
    }

    const sha256 = hashAttachmentContent(content);
    return {
      snapshots: [{
        filename: resolvedInfo.filename,
        contentSha256: sha256,
        byteLength: content.byteLength,
        contentType,
        contentId: null,
      }],
      blobs: [
        {
          sha256,
          content: Uint8Array.from(content),
          byteLength: content.byteLength,
        },
      ],
      warnings: [],
      rateCardAttachmentOmitted: false,
    };
  } catch (error) {
    if (error instanceof ResendPreparationError) throw error;
    const message = error instanceof Error ? error.message : "unknown attachment error";
    const preparationDisposition =
      resolvedInfo?.kind === "url" || isTransientFileError(error)
        ? "retryable"
        : "permanent";
    throw new ResendPreparationError(
      `Unable to snapshot rate card attachment: ${message}`,
      preparationDisposition,
    );
  }
}

export interface ResendDeliveryPolicy {
  from: string;
  intendedRecipients: string[];
  to: string[];
  bcc: string[];
  subject: string;
  testSend: boolean;
}

export type ResendDeliveryPolicyResult =
  | { ok: true; policy: ResendDeliveryPolicy }
  | { ok: false; error: string };

export interface BuildResendDeliveryPolicyArgs {
  from: string | undefined;
  intendedRecipients: string[];
  subject: string;
  testOverride: string | null;
  bccEmails: string[];
  suppressedEmails: Iterable<string>;
  allowMissingFrom?: boolean;
}

export function buildResendDeliveryPolicy({
  from,
  intendedRecipients,
  subject,
  testOverride,
  bccEmails,
  suppressedEmails,
  allowMissingFrom = false,
}: BuildResendDeliveryPolicyArgs): ResendDeliveryPolicyResult {
  const normalizedFrom = from?.trim();
  if (!normalizedFrom && !allowMissingFrom) {
    return { ok: false, error: "Missing RESEND_FROM_EMAIL" };
  }
  if (normalizedFrom && !isValidResendSender(normalizedFrom)) {
    return {
      ok: false,
      error:
        "Invalid RESEND_FROM_EMAIL; expected email@example.com or Name <email@example.com>",
    };
  }

  const blocked = new Set(normalizeEmails(Array.from(suppressedEmails)));
  const allowedIntended = normalizeEmails(intendedRecipients).filter(
    (email) => !blocked.has(email),
  );
  if (allowedIntended.length === 0) {
    return {
      ok: false,
      error: "All intended recipient addresses are suppressed or invalid",
    };
  }

  const overrideEmail = testOverride ? normalizeEmail(testOverride) : null;
  if (testOverride && !overrideEmail) {
    return { ok: false, error: "Test override email is invalid" };
  }
  if (overrideEmail && blocked.has(overrideEmail)) {
    return { ok: false, error: "Test override email is suppressed" };
  }

  const allowedBcc = overrideEmail
    ? []
    : normalizeEmails(bccEmails).filter((email) => !blocked.has(email));
  return {
    ok: true,
    policy: {
      from: normalizedFrom ?? "",
      intendedRecipients: allowedIntended,
      to: overrideEmail ? [overrideEmail] : allowedIntended,
      bcc: allowedBcc,
      subject: overrideEmail
        ? `[TEST → ${allowedIntended.join(", ")}] ${subject}`
        : subject,
      testSend: !!overrideEmail,
    },
  };
}

export async function resolveResendDeliveryPolicy(
  intendedRecipients: string[],
  subject: string,
): Promise<ResendDeliveryPolicyResult> {
  const { from, testOverride, bccEmails } =
    await getResendDeliverySettingsSnapshot();
  const candidates = normalizeEmails([
    ...intendedRecipients,
    ...bccEmails,
    ...(testOverride ? [testOverride] : []),
  ]);
  const suppressed =
    candidates.length === 0
      ? []
      : await db.emailSuppression.findMany({
          where: { normalizedEmail: { in: candidates } },
          select: { normalizedEmail: true },
        });
  return buildResendDeliveryPolicy({
    from,
    intendedRecipients,
    subject,
    testOverride,
    bccEmails,
    suppressedEmails: suppressed.map((row) => row.normalizedEmail),
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function compareResendRequestToPolicy(
  request: ResendRequestSnapshot,
  testSend: boolean,
  policy: ResendDeliveryPolicy,
): string | null {
  if (request.from !== policy.from) return "configured sender changed";
  if (testSend !== policy.testSend) {
    return policy.testSend
      ? "test mode is now enabled"
      : "test mode is now disabled";
  }
  if (!sameStrings(request.to, policy.to)) {
    return "recipient or test-override policy changed";
  }
  if (!sameStrings(request.bcc, policy.bcc)) return "BCC policy changed";
  if (request.cc.length > 0 || request.replyTo.length > 0) {
    return "stored CC or reply-to fields are not allowed by current policy";
  }
  if (request.subject !== policy.subject) return "test-mode subject policy changed";
  return null;
}

export async function evaluateResendRetryPolicy(
  request: ResendRequestSnapshot,
  intendedRecipients: string[],
  baseSubject: string,
  testSend: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolveResendDeliveryPolicy(
    intendedRecipients,
    baseSubject,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      error: `Current send policy blocks this immutable request: ${resolved.error}`,
    };
  }
  const conflict = compareResendRequestToPolicy(
    request,
    testSend,
    resolved.policy,
  );
  return conflict
    ? {
        ok: false,
        error: `Current send policy conflicts with the immutable request: ${conflict}`,
      }
    : { ok: true };
}

export async function prepareResendRequest({
  to,
  subject,
  html,
  outreachId,
  attemptId,
  idempotencyKey,
}: PrepareResendRequestArgs): Promise<PrepareResendRequestResult> {
  const resolvedPolicy = await resolveResendDeliveryPolicy(to, subject);
  if (!resolvedPolicy.ok) {
    return {
      ...resolvedPolicy,
      preparationDisposition: "permanent",
    };
  }
  const { policy } = resolvedPolicy;

  const request: ResendRequestSnapshot = {
    version: 1,
    idempotencyKey,
    from: policy.from,
    to: policy.to,
    cc: [],
    bcc: policy.bcc,
    replyTo: [],
    subject: policy.subject,
    html,
    headers: {
      "X-Outreach-Id": outreachId,
      "X-Outreach-Attempt-Id": attemptId,
    },
    tags: [
      { name: "outreach_id", value: outreachId },
      { name: "outreach_attempt_id", value: attemptId },
    ],
    attachments: [],
  };

  return {
    ok: true,
    request,
    requestHash: hashResendRequestSnapshot(request),
    testSend: policy.testSend,
    attachmentBlobs: [],
    warnings: [],
    rateCardAttachmentOmitted: false,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function hashResendRequestSnapshot(request: ResendRequestSnapshot): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

export function hashAttachmentContent(
  content: Uint8Array<ArrayBufferLike>,
): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : null;
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    return null;
  }
  return Object.fromEntries(Object.entries(value) as [string, string][]);
}

export function parseResendRequestSnapshot(value: unknown): ResendRequestSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "idempotencyKey",
      "from",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "subject",
      "html",
      "headers",
      "tags",
      "attachments",
    ]) ||
    value.version !== 1 ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.from !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.html !== "string"
  ) {
    return null;
  }

  const to = readStringArray(value.to);
  const cc = readStringArray(value.cc);
  const bcc = readStringArray(value.bcc);
  const replyTo = readStringArray(value.replyTo);
  const headers = readStringRecord(value.headers);
  if (!to || to.length === 0 || !cc || !bcc || !replyTo || !headers) return null;

  if (
    !Array.isArray(value.tags) ||
    !value.tags.every(
      (tag) =>
        isRecord(tag) &&
        hasExactKeys(tag, ["name", "value"]) &&
        typeof tag.name === "string" &&
        typeof tag.value === "string",
    ) ||
    !Array.isArray(value.attachments) ||
    !value.attachments.every(
      (attachment) =>
        isRecord(attachment) &&
        hasExactKeys(attachment, [
          "filename",
          "contentSha256",
          "byteLength",
          "contentType",
          "contentId",
        ]) &&
        typeof attachment.filename === "string" &&
        typeof attachment.contentSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(attachment.contentSha256) &&
        typeof attachment.byteLength === "number" &&
        Number.isSafeInteger(attachment.byteLength) &&
        attachment.byteLength >= 0 &&
        (attachment.contentType === null || typeof attachment.contentType === "string") &&
        (attachment.contentId === null || typeof attachment.contentId === "string"),
    )
  ) {
    return null;
  }

  return {
    version: 1,
    idempotencyKey: value.idempotencyKey,
    from: value.from,
    to,
    cc,
    bcc,
    replyTo,
    subject: value.subject,
    html: value.html,
    headers,
    tags: value.tags.map((tag) => ({
      name: (tag as Record<string, string>).name,
      value: (tag as Record<string, string>).value,
    })),
    attachments: value.attachments.map((attachment) => ({
      filename: (attachment as Record<string, string>).filename,
      contentSha256: (attachment as Record<string, string>).contentSha256,
      byteLength: (attachment as Record<string, number>).byteLength,
      contentType: (attachment as Record<string, string | null>).contentType,
      contentId: (attachment as Record<string, string | null>).contentId,
    })),
  };
}

export function canRetryResendRequest(
  firstAttemptAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!firstAttemptAt) return true;
  const age = now.getTime() - firstAttemptAt.getTime();
  return age >= 0 && age < RESEND_IDEMPOTENCY_RETENTION_MS;
}

const RESEND_CREDENTIAL_ERROR_NAMES = new Set<ErrorResponse["name"]>([
  "missing_api_key",
  "restricted_api_key",
  "invalid_api_key",
  "invalid_access",
]);

const RESEND_QUOTA_ERROR_NAMES = new Set<ErrorResponse["name"]>([
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
]);

function isCorrectableSenderConfigurationError(
  error: Pick<ErrorResponse, "name" | "statusCode"> &
    Partial<Pick<ErrorResponse, "message">>,
): boolean {
  if (error.name === "invalid_from_address") return true;
  return (
    error.name === "validation_error" &&
    error.statusCode === 403 &&
    /\b(domain|sender|from|testing emails?|verif(?:y|ied|ication))\b/i.test(
      error.message ?? "",
    )
  );
}

export function classifyResendProviderError(
  error: Pick<ErrorResponse, "name" | "statusCode"> &
    Partial<Pick<ErrorResponse, "message">>,
): ResendFailureDisposition {
  if (
    error.statusCode === 401 ||
    RESEND_CREDENTIAL_ERROR_NAMES.has(error.name) ||
    RESEND_QUOTA_ERROR_NAMES.has(error.name) ||
    isCorrectableSenderConfigurationError(error)
  ) {
    return "configuration";
  }
  if (
    error.name === "concurrent_idempotent_requests"
  ) {
    return "in_flight";
  }
  if (
    error.name === "rate_limit_exceeded" ||
    error.statusCode === 408 ||
    error.statusCode === 425
  ) {
    return "retryable";
  }
  if (
    error.name === "invalid_idempotency_key" ||
    error.name === "invalid_idempotent_request"
  ) {
    return "policy";
  }
  if (
    error.statusCode !== null &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    ![408, 409, 425].includes(error.statusCode)
  ) {
    return "permanent";
  }
  return "uncertain";
}

export async function sendPreparedEmailViaResend(
  request: ResendRequestSnapshot,
  expectedHash: string,
  attachmentBlobs: ResendAttachmentBlob[],
  submissionCredential: ResendSubmissionCredential | null,
): Promise<SendResult> {
  if (hashResendRequestSnapshot(request) !== expectedHash) {
    return {
      providerMessageId: null,
      error: "Stored Resend request failed its integrity check",
      failureDisposition: "policy",
    };
  }
  const blobsByHash = new Map(attachmentBlobs.map((blob) => [blob.sha256, blob]));
  const resolvedAttachments = [];
  for (const attachment of request.attachments) {
    const blob = blobsByHash.get(attachment.contentSha256);
    if (
      !blob ||
      blob.byteLength !== attachment.byteLength ||
      blob.content.byteLength !== attachment.byteLength ||
      hashAttachmentContent(blob.content) !== attachment.contentSha256
    ) {
      return {
        providerMessageId: null,
        error: "Stored Resend attachment failed its identity or integrity check",
        failureDisposition: "policy",
      };
    }
    resolvedAttachments.push({
      filename: attachment.filename,
      content: Buffer.from(blob.content).toString("base64"),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    });
  }

  const configurationError = getResendConfigurationError(
    submissionCredential?.apiKey,
    request.from,
  );
  if (configurationError) {
    return {
      providerMessageId: null,
      error: configurationError,
      failureDisposition: "configuration",
    };
  }
  if (
    !submissionCredential ||
    getResendCredentialScope(submissionCredential.apiKey) !==
      submissionCredential.scope
  ) {
    return {
      providerMessageId: null,
      error: "Resend submission credential failed its scope integrity check",
      failureDisposition: "policy",
    };
  }

  try {
    const result = await client(submissionCredential.apiKey).emails.send(
      {
        from: request.from,
        to: request.to,
        subject: request.subject,
        html: request.html,
        headers: request.headers,
        tags: request.tags,
        ...(request.cc.length > 0
          ? { cc: request.cc.length === 1 ? request.cc[0] : request.cc }
          : {}),
        ...(request.bcc.length > 0
          ? { bcc: request.bcc.length === 1 ? request.bcc[0] : request.bcc }
          : {}),
        ...(request.replyTo.length > 0
          ? {
              replyTo:
                request.replyTo.length === 1 ? request.replyTo[0] : request.replyTo,
            }
          : {}),
        ...(resolvedAttachments.length > 0
          ? { attachments: resolvedAttachments }
          : {}),
      },
      { idempotencyKey: request.idempotencyKey },
    );
    if (result.error) {
      return {
        providerMessageId: null,
        error: `Resend ${result.error.name}${
          result.error.statusCode === null
            ? ""
            : ` (${result.error.statusCode})`
        }: ${result.error.message}`,
        failureDisposition: classifyResendProviderError(result.error),
      };
    }
    if (!result.data?.id) {
      return {
        providerMessageId: null,
        error: "Resend returned no provider message ID",
        failureDisposition: "uncertain",
      };
    }
    return {
      providerMessageId: result.data.id,
      error: null,
      failureDisposition: null,
    };
  } catch (error) {
    return {
      providerMessageId: null,
      error: error instanceof Error ? error.message : String(error),
      failureDisposition: "uncertain",
    };
  }
}

export interface ResendAttemptIdentity {
  id: string;
  outreachId: string;
  providerMessageId: string | null;
  status?: string;
  testSend?: boolean | null;
  providerCredentialScope?: string | null;
}

export interface ResendCorrelationClaims {
  attemptId: string | null;
  outreachId: string | null;
  providerMessageId: string | null;
}

export type ResendCorrelationResult =
  | {
      status: "matched";
      attempt: ResendAttemptIdentity;
      bindProviderMessageId: boolean;
    }
  | { status: "conflict" | "unmatched"; reason: string };

export interface ResendWebhookFailurePolicy {
  applySuppression: boolean;
  mirrorOutreachFailure: boolean;
  preserveTestOutreachState: boolean;
  processAttemptEvents: boolean;
}

export function getResendWebhookFailurePolicy(
  attempt: { status?: string; testSend?: boolean | null } | null,
): ResendWebhookFailurePolicy {
  if (!attempt) {
    return {
      applySuppression: false,
      mirrorOutreachFailure: false,
      preserveTestOutreachState: false,
      processAttemptEvents: false,
    };
  }

  const isolateTestFailure = attempt?.testSend === true;
  const quarantineUnknownAttempt =
    attempt?.testSend == null ||
    attempt?.status === "legacy_unknown";
  return {
    applySuppression: !isolateTestFailure && !quarantineUnknownAttempt,
    mirrorOutreachFailure: !isolateTestFailure && !quarantineUnknownAttempt,
    preserveTestOutreachState:
      isolateTestFailure && !quarantineUnknownAttempt,
    processAttemptEvents: !quarantineUnknownAttempt,
  };
}

export function canBindResendWebhookProviderMessage(
  attempt: Pick<
    ResendAttemptIdentity,
    "status" | "testSend" | "providerCredentialScope"
  >,
): boolean {
  // A verified provider event is the reconciliation path for migrated
  // scope-less attempts; only ambiguous real/test identity stays quarantined.
  return attempt.testSend != null && attempt.status !== "legacy_unknown";
}

export function shouldMirrorResendAttempt(
  outreach: {
    idempotencyKey: string;
    providerMessageId: string | null;
    status?: string;
  },
  attempt: {
    idempotencyKey: string;
    providerMessageId: string | null;
  },
): boolean {
  if (
    outreach.idempotencyKey !== attempt.idempotencyKey ||
    !attempt.providerMessageId
  ) {
    return false;
  }
  return (
    outreach.providerMessageId === null ||
    outreach.providerMessageId === attempt.providerMessageId
  );
}

export function correlateResendWebhookAttempt(
  claims: ResendCorrelationClaims,
  taggedAttempt: ResendAttemptIdentity | null,
  messageAttempt: ResendAttemptIdentity | null,
  outreachAttempt: ResendAttemptIdentity | null = null,
): ResendCorrelationResult {
  if (claims.attemptId && !taggedAttempt) {
    return { status: "unmatched", reason: "tagged attempt does not exist" };
  }
  if (
    taggedAttempt &&
    messageAttempt &&
    taggedAttempt.id !== messageAttempt.id
  ) {
    return {
      status: "conflict",
      reason: "attempt tag and provider message identify different attempts",
    };
  }
  if (
    outreachAttempt &&
    taggedAttempt &&
    outreachAttempt.id !== taggedAttempt.id
  ) {
    return {
      status: "conflict",
      reason: "outreach tag and attempt tag identify different attempts",
    };
  }
  if (
    outreachAttempt &&
    messageAttempt &&
    outreachAttempt.id !== messageAttempt.id
  ) {
    return {
      status: "conflict",
      reason: "outreach tag and provider message identify different attempts",
    };
  }

  const attempt = messageAttempt ?? taggedAttempt ?? outreachAttempt;
  if (!attempt) {
    return { status: "unmatched", reason: "no immutable attempt matched the event" };
  }
  if (claims.attemptId && claims.attemptId !== attempt.id) {
    return { status: "conflict", reason: "attempt tag contradicts provider message" };
  }
  if (claims.outreachId && claims.outreachId !== attempt.outreachId) {
    return { status: "conflict", reason: "outreach tag contradicts matched attempt" };
  }
  if (
    claims.providerMessageId &&
    attempt.providerMessageId &&
    claims.providerMessageId !== attempt.providerMessageId
  ) {
    return {
      status: "conflict",
      reason: "provider message contradicts immutable attempt identity",
    };
  }

  return {
    status: "matched",
    attempt,
    bindProviderMessageId:
      !!claims.providerMessageId && attempt.providerMessageId === null,
  };
}
