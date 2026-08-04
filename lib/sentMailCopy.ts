import { createHash, randomUUID } from "node:crypto";
import { ImapFlow, type AppendResponseObject, type ListResponse } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  getSentMailImapConfiguration,
  SENT_MAIL_COPY_MAILBOX_KEY,
  type SentMailImapConfiguration,
} from "@/lib/sentMailConfig";
import {
  hashAttachmentContent,
  hashResendRequestSnapshot,
  parseResendRequestSnapshot,
  type ResendAttachmentBlob,
  type ResendRequestSnapshot,
} from "@/lib/resend";

export const SENT_MAIL_COPY_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
export const SENT_MAIL_COPY_MAX_ATTEMPTS = 8;
export const SENT_MAIL_COPY_MIN_START_BUDGET_MS = 25_000;
export const SENT_MAIL_COPY_DEADLINE_ERROR =
  "IMAP Sent copy exceeded the dispatcher deadline";
const SENT_MAIL_COPY_RETRY_BASE_MS = 60 * 1000;
const SENT_MAIL_COPY_RETRY_MAX_MS = 60 * 60 * 1000;

export type SentMailCopySource =
  | {
      kind: "outreach";
      id: string;
      providerMessageId: string;
      requested: boolean | null;
      targetScope: string | null;
      configurationError: string | null;
      testSend: boolean | null;
    }
  | {
      kind: "arbitrary";
      id: string;
      providerMessageId: string;
      requested: boolean | null;
      targetScope: string | null;
      configurationError: string | null;
      testSend: boolean | null;
    };

export interface SentMailCopyDispatchResult {
  id: string;
  ok: boolean;
  skipped?: boolean;
  retryScheduled?: boolean;
  nextAttemptAt?: Date;
  error?: string;
}

export interface SentMailCopyDispatchOptions {
  deadlineAtMs?: number;
  minimumStartBudgetMs?: number;
  nowMs?: () => number;
}

export function hasSentMailCopyAttemptBudget(
  options: SentMailCopyDispatchOptions,
): boolean {
  if (options.deadlineAtMs === undefined) return true;
  const nowMs = options.nowMs ?? Date.now;
  return (
    options.deadlineAtMs - nowMs() >=
    (options.minimumStartBudgetMs ?? SENT_MAIL_COPY_MIN_START_BUDGET_MS)
  );
}

export function canRefreshSentMailboxTargetBeforeSubmission(state: {
  status: string;
  providerMessageId: string | null;
  firstAttemptAt: Date | null;
  attemptCount: number;
  failureDisposition: string | null;
}): boolean {
  if (state.providerMessageId) return false;
  if (state.firstAttemptAt === null && state.attemptCount === 0) {
    return state.status === "prepared" || state.status === "queued";
  }
  return ["configuration", "retryable", "permanent", "policy"].includes(
    state.failureDisposition ?? "",
  );
}

type SentMailCopyTransaction = Pick<
  Prisma.TransactionClient,
  "sentMailCopy"
>;

export async function ensureSentMailCopyQueued(
  tx: SentMailCopyTransaction,
  source: SentMailCopySource,
): Promise<void> {
  if (!source.requested || source.testSend !== false) return;
  const id =
    source.kind === "outreach"
      ? `outreach-attempt/${source.id}`
      : `arbitrary-email/${source.id}`;
  const configurationError =
    source.configurationError ??
    (source.targetScope
      ? null
      : "Sent mailbox copy has no immutable target because configuration was invalid at acceptance");
  const queued = await tx.sentMailCopy.upsert({
    where: { id },
    create: {
      id,
      providerMessageId: source.providerMessageId,
      targetScope: source.targetScope,
      status: source.targetScope
        ? configurationError
          ? "retry_scheduled"
          : "pending"
        : "manual_review",
      error: configurationError,
      ...(source.kind === "outreach"
        ? { outreachAttemptId: source.id }
        : { arbitraryEmailId: source.id }),
    },
    update: {
      providerMessageId: source.providerMessageId,
    },
  });
  if (
    queued.providerMessageId !== source.providerMessageId ||
    queued.targetScope !== source.targetScope ||
    (source.kind === "outreach"
      ? queued.outreachAttemptId !== source.id ||
        queued.arbitraryEmailId !== null
      : queued.arbitraryEmailId !== source.id ||
        queued.outreachAttemptId !== null)
  ) {
    throw new Error("Sent copy identity conflicts with its accepted source");
  }
}

function sentMailCopyMessageId(copyId: string): string {
  const digest = createHash("sha256")
    .update("photo-admin/sent-mail-copy/v1\0")
    .update(copyId)
    .digest("hex");
  return `<sent-copy-${digest}@photo-admin.invalid>`;
}

export async function buildSentMailCopyMime(
  copyId: string,
  providerMessageId: string,
  request: ResendRequestSnapshot,
  expectedHash: string,
  acceptedAt: Date,
  attachmentBlobs: ResendAttachmentBlob[],
): Promise<Buffer> {
  if (hashResendRequestSnapshot(request) !== expectedHash) {
    throw new Error("Stored provider request failed its integrity check");
  }
  const blobsByHash = new Map(attachmentBlobs.map((blob) => [blob.sha256, blob]));
  const attachments = request.attachments.map((attachment) => {
    const blob = blobsByHash.get(attachment.contentSha256);
    if (
      !blob ||
      blob.byteLength !== attachment.byteLength ||
      blob.content.byteLength !== attachment.byteLength ||
      hashAttachmentContent(blob.content) !== attachment.contentSha256
    ) {
      throw new Error("Stored attachment failed its integrity check");
    }
    return {
      filename: attachment.filename,
      content: Buffer.from(blob.content),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.contentId ? { cid: attachment.contentId } : {}),
    };
  });
  const composer = new MailComposer({
    from: request.from,
    to: request.to,
    ...(request.cc.length > 0 ? { cc: request.cc } : {}),
    ...(request.bcc.length > 0 ? { bcc: request.bcc } : {}),
    ...(request.replyTo.length > 0 ? { replyTo: request.replyTo } : {}),
    subject: request.subject,
    html: request.html,
    ...(request.text ? { text: request.text } : {}),
    date: acceptedAt,
    messageId: sentMailCopyMessageId(copyId),
    headers: {
      ...request.headers,
      "X-Photo-Admin-Sent-Copy-Id": copyId,
      "X-Photo-Admin-Resend-Message-Id": providerMessageId,
    },
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
    xMailer: false,
  });
  const message = composer.compile();
  message.keepBcc = true;
  return message.build();
}

export interface SentMailImapClient {
  usable: boolean;
  connect(): Promise<void>;
  list(): Promise<ListResponse[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(
    query: { header: Record<string, string> },
    options: { uid: true },
  ): Promise<number[] | false>;
  append(
    path: string,
    content: Buffer,
    flags?: string[],
    idate?: Date,
  ): Promise<AppendResponseObject | false>;
  logout(): Promise<void>;
  close(): void;
}

function defaultImapClient(
  config: SentMailImapConfiguration,
): SentMailImapClient {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
    clientInfo: {
      name: "photo-admin",
      version: "1",
      vendor: "zspherez/photo-admin",
    },
    logger: false,
    emitLogs: false,
    logRaw: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export interface SentMailAppendResult {
  mailbox: string;
  uid: number | null;
  uidValidity: bigint | null;
  alreadyPresent: boolean;
}

export async function appendSentMailCopy(
  config: SentMailImapConfiguration,
  expectedTargetScope: string,
  copyId: string,
  rawMessage: Buffer,
  acceptedAt: Date,
  createClient: (
    config: SentMailImapConfiguration,
  ) => SentMailImapClient = defaultImapClient,
  options: Pick<SentMailCopyDispatchOptions, "deadlineAtMs" | "nowMs"> = {},
): Promise<SentMailAppendResult> {
  if (config.targetScope !== expectedTargetScope) {
    throw new Error(
      "Current IMAP mailbox target does not match the immutable target captured at acceptance",
    );
  }
  const client = createClient(config);
  let lock: { release(): void } | null = null;
  let deadlineExpired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.deadlineAtMs !== undefined) {
    const remainingMs =
      options.deadlineAtMs - (options.nowMs ?? Date.now)();
    if (remainingMs <= 0) throw new Error(SENT_MAIL_COPY_DEADLINE_ERROR);
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      client.close();
    }, remainingMs);
  }
  try {
    await client.connect();
    const mailboxes = await client.list();
    const mailbox = config.mailbox
      ? mailboxes.find((entry) => entry.path === config.mailbox)?.path
      : mailboxes.find((entry) => entry.specialUse === "\\Sent")?.path;
    if (!mailbox) {
      throw new Error(
        config.mailbox
          ? "Configured Sent mailbox was not found"
          : "IMAP server did not advertise a Sent mailbox; configure an explicit mailbox override",
      );
    }

    lock = await client.getMailboxLock(mailbox);
    const existing = await client.search(
      { header: { "X-Photo-Admin-Sent-Copy-Id": copyId } },
      { uid: true },
    );
    if (existing && existing.length > 0) {
      return {
        mailbox,
        uid: existing[0] ?? null,
        uidValidity: null,
        alreadyPresent: true,
      };
    }

    const appended = await client.append(
      mailbox,
      rawMessage,
      ["\\Seen"],
      acceptedAt,
    );
    if (!appended) throw new Error("IMAP server did not confirm APPEND");
    return {
      mailbox,
      uid: appended.uid ?? null,
      uidValidity: appended.uidValidity ?? null,
      alreadyPresent: false,
    };
  } catch (error) {
    if (deadlineExpired) throw new Error(SENT_MAIL_COPY_DEADLINE_ERROR);
    throw error;
  } finally {
    lock?.release();
    if (deadlineExpired) {
      client.close();
    } else if (client.usable) {
      await client.logout().catch(() => client.close());
    } else {
      client.close();
    }
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function retryAt(attemptCount: number, now: Date): Date {
  const delay = Math.min(
    SENT_MAIL_COPY_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
    SENT_MAIL_COPY_RETRY_MAX_MS,
  );
  return new Date(now.getTime() + delay);
}

function operationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "Configured Sent mailbox was not found" ||
    message.startsWith("IMAP server did not advertise a Sent mailbox") ||
    message === "IMAP server did not confirm APPEND" ||
    message === SENT_MAIL_COPY_DEADLINE_ERROR
  ) {
    return message;
  }
  return "IMAP Sent copy failed; verify connectivity, mailbox mapping, and the app password";
}

async function claimSentMailCopy(
  id: string,
  now: Date,
): Promise<
  | { ok: true; claimToken: string; attemptCount: number }
  | { ok: false; result: SentMailCopyDispatchResult }
> {
  const staleBefore = new Date(now.getTime() - SENT_MAIL_COPY_CLAIM_TIMEOUT_MS);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "SentMailCopy"
          WHERE "id" = ${id}
          FOR UPDATE
        `,
      );
      const row = await tx.sentMailCopy.findUnique({ where: { id } });
      if (!row) {
        return {
          ok: false as const,
          result: { id, ok: false, error: "Sent copy record was not found" },
        };
      }
      if (row.status === "copied") {
        return {
          ok: false as const,
          result: { id, ok: true, skipped: true },
        };
      }
      const claimable =
        ((row.status === "pending" || row.status === "retry_scheduled") &&
          row.nextAttemptAt <= now) ||
        (row.status === "copying" &&
          row.claimedAt !== null &&
          row.claimedAt <= staleBefore);
      if (!claimable) {
        return {
          ok: false as const,
          result: { id, ok: true, skipped: true },
        };
      }
      const claimToken = randomUUID();
      const attemptCount = row.attemptCount + 1;
      await tx.sentMailCopy.update({
        where: { id },
        data: {
          status: "copying",
          attemptCount,
          claimedAt: now,
          claimToken,
          error: null,
        },
      });
      return { ok: true as const, claimToken, attemptCount };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function sentMailCopyDeadlineReleaseData(now: Date) {
  return {
    status: "retry_scheduled",
    error: "Sent copy deferred because the dispatcher deadline is near",
    nextAttemptAt: now,
    claimedAt: null,
    claimToken: null,
    attemptCount: { decrement: 1 },
  } as const;
}

async function releaseSentMailCopyClaimForDeadline(
  id: string,
  claimToken: string,
  now: Date,
): Promise<SentMailCopyDispatchResult> {
  const released = await db.sentMailCopy.updateMany({
    where: { id, status: "copying", claimToken },
    data: sentMailCopyDeadlineReleaseData(now),
  });
  if (released.count !== 1) {
    return {
      id,
      ok: false,
      error: "Sent copy claim changed while deferring for the deadline",
    };
  }
  return {
    id,
    ok: true,
    skipped: true,
    retryScheduled: true,
    nextAttemptAt: now,
  };
}

async function loadSentMailCopyMessage(id: string) {
  const row = await db.sentMailCopy.findUnique({
    where: { id },
    include: {
      outreachAttempt: true,
      arbitraryEmail: true,
    },
  });
  if (!row) return { ok: false as const, error: "Sent copy record was not found" };

  const source = row.outreachAttempt ?? row.arbitraryEmail;
  if (
    !source ||
    source.providerMessageId !== row.providerMessageId ||
    source.testSend !== false ||
    source.sentMailboxCopyRequested !== true ||
    source.sentMailboxTargetScope !== row.targetScope ||
    !row.targetScope ||
    !source.providerRequest ||
    !source.requestHash
  ) {
    return {
      ok: false as const,
      error: "Sent copy source identity is incomplete or inconsistent",
    };
  }
  const request = parseResendRequestSnapshot(source.providerRequest);
  if (!request || hashResendRequestSnapshot(request) !== source.requestHash) {
    return {
      ok: false as const,
      error: "Sent copy source request failed its integrity check",
    };
  }
  const acceptedAt =
    row.outreachAttempt?.acceptedAt ??
    row.arbitraryEmail?.sentAt ??
    row.createdAt;
  const attachmentRows =
    request.attachments.length === 0
      ? []
      : await db.outreachAttachmentBlob.findMany({
          where: {
            sha256: {
              in: request.attachments.map(
                (attachment) => attachment.contentSha256,
              ),
            },
          },
        });
  return {
    ok: true as const,
    row,
    request,
    expectedHash: source.requestHash,
    acceptedAt,
    attachmentBlobs: attachmentRows,
  };
}

export async function dispatchSentMailCopy(
  id: string,
  now: Date = new Date(),
  options: SentMailCopyDispatchOptions = {},
): Promise<SentMailCopyDispatchResult> {
  if (!hasSentMailCopyAttemptBudget(options)) {
    return { id, ok: true, skipped: true };
  }
  const claim = await claimSentMailCopy(id, now);
  if (!claim.ok) return claim.result;
  if (!hasSentMailCopyAttemptBudget(options)) {
    return releaseSentMailCopyClaimForDeadline(id, claim.claimToken, now);
  }

  const loaded = await loadSentMailCopyMessage(id);
  if (!loaded.ok) {
    await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: "manual_review",
        error: loaded.error,
        nextAttemptAt: now,
        claimedAt: null,
        claimToken: null,
      },
    });
    return { id, ok: false, error: loaded.error };
  }

  const mailboxSetting = await db.setting.findUnique({
    where: { key: SENT_MAIL_COPY_MAILBOX_KEY },
  });
  const configuration = getSentMailImapConfiguration(mailboxSetting?.value);
  if (!configuration.ok) {
    const nextAttemptAt = retryAt(claim.attemptCount, now);
    await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: "retry_scheduled",
        error: configuration.error,
        nextAttemptAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    return {
      id,
      ok: false,
      error: configuration.error,
      retryScheduled: true,
      nextAttemptAt,
    };
  }
  if (configuration.config.targetScope !== loaded.row.targetScope) {
    const nextAttemptAt = retryAt(claim.attemptCount, now);
    const error =
      "Current IMAP mailbox target does not match the immutable target captured at acceptance";
    await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: "retry_scheduled",
        error,
        nextAttemptAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    return {
      id,
      ok: false,
      error,
      retryScheduled: true,
      nextAttemptAt,
    };
  }

  let rawMessage: Buffer;
  try {
    rawMessage = await buildSentMailCopyMime(
      id,
      loaded.row.providerMessageId,
      loaded.request,
      loaded.expectedHash,
      loaded.acceptedAt,
      loaded.attachmentBlobs,
    );
  } catch {
    const error = "Sent copy MIME snapshot failed its integrity check";
    await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: "manual_review",
        error,
        nextAttemptAt: now,
        claimedAt: null,
        claimToken: null,
      },
    });
    return { id, ok: false, error };
  }

  if (!hasSentMailCopyAttemptBudget(options)) {
    return releaseSentMailCopyClaimForDeadline(id, claim.claimToken, now);
  }
  try {
    const appended = await appendSentMailCopy(
      configuration.config,
      loaded.row.targetScope,
      id,
      rawMessage,
      loaded.acceptedAt,
      defaultImapClient,
      options,
    );
    const completedAt = new Date();
    const completed = await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: "copied",
        mailbox: appended.mailbox,
        mailboxUid: appended.uid?.toString() ?? null,
        mailboxUidValidity: appended.uidValidity?.toString() ?? null,
        error: null,
        copiedAt: completedAt,
        nextAttemptAt: completedAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    if (completed.count !== 1) {
      return {
        id,
        ok: false,
        error: "Sent copy claim changed after IMAP confirmation",
      };
    }
    return { id, ok: true };
  } catch (cause) {
    const terminal = claim.attemptCount >= SENT_MAIL_COPY_MAX_ATTEMPTS;
    const nextAttemptAt = retryAt(claim.attemptCount, now);
    const error = operationalError(cause);
    await db.sentMailCopy.updateMany({
      where: { id, status: "copying", claimToken: claim.claimToken },
      data: {
        status: terminal ? "manual_review" : "retry_scheduled",
        error,
        nextAttemptAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    return {
      id,
      ok: false,
      error,
      retryScheduled: !terminal,
      nextAttemptAt,
    };
  }
}

export interface SentMailCopyBatchDependencies {
  findDue: (
    limit: number,
    now: Date,
  ) => Promise<Array<{ id: string }>>;
  dispatch: typeof dispatchSentMailCopy;
}

const DEFAULT_BATCH_DEPENDENCIES: SentMailCopyBatchDependencies = {
  findDue: async (limit, now) => {
    const staleBefore = new Date(
      now.getTime() - SENT_MAIL_COPY_CLAIM_TIMEOUT_MS,
    );
    return db.sentMailCopy.findMany({
      where: {
        OR: [
          {
            status: { in: ["pending", "retry_scheduled"] },
            nextAttemptAt: { lte: now },
          },
          {
            status: "copying",
            claimedAt: { lte: staleBefore },
          },
        ],
      },
      select: { id: true },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(limit, 10)),
    });
  },
  dispatch: dispatchSentMailCopy,
};

export async function dispatchDueSentMailCopiesWithDependencies(
  limit = 5,
  now: Date = new Date(),
  options: SentMailCopyDispatchOptions = {},
  dependencies: SentMailCopyBatchDependencies,
): Promise<SentMailCopyDispatchResult[]> {
  if (!hasSentMailCopyAttemptBudget(options)) return [];
  const rows = await dependencies.findDue(limit, now);
  const results: SentMailCopyDispatchResult[] = [];
  for (const row of rows) {
    if (!hasSentMailCopyAttemptBudget(options)) break;
    const dispatchNow = new Date((options.nowMs ?? Date.now)());
    results.push(
      await dependencies.dispatch(row.id, dispatchNow, options),
    );
  }
  return results;
}

export async function dispatchDueSentMailCopies(
  limit = 5,
  now: Date = new Date(),
  options: SentMailCopyDispatchOptions = {},
): Promise<SentMailCopyDispatchResult[]> {
  return dispatchDueSentMailCopiesWithDependencies(
    limit,
    now,
    options,
    DEFAULT_BATCH_DEPENDENCIES,
  );
}
