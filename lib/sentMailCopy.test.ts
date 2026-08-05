import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  appendSentMailCopy,
  buildSentMailCopyMime,
  canRefreshSentMailboxTargetBeforeSubmission,
  dispatchDueSentMailCopiesWithDependencies,
  ensureOutreachSentMailCopiesQueued,
  ensureSentMailCopyQueued,
  hasSentMailCopyAttemptBudget,
  SENT_MAIL_COPY_DEADLINE_ERROR,
  SENT_MAIL_COPY_MAX_ATTEMPTS,
  sentMailCopyFailureState,
  sentMailCopyDeadlineReleaseData,
  sentMailCopyStaleRecovery,
  type SentMailCopyBatchDependencies,
  type SentMailImapClient,
} from "./sentMailCopy";
import {
  getSentMailImapConfiguration,
  getSentMailTarget,
  resolveSentMailCopyRequestState,
  type SentMailImapConfiguration,
} from "./sentMailConfig";
import {
  hashAttachmentContent,
  hashResendRequestSnapshot,
  type ResendRequestSnapshot,
} from "./resend";

const ENV = {
  NODE_ENV: "test",
  SENT_MAIL_IMAP_HOST: "imap.gmail.com",
  SENT_MAIL_IMAP_PORT: "993",
  SENT_MAIL_IMAP_SECURE: "true",
  SENT_MAIL_IMAP_USERNAME: "sender@example.com",
  SENT_MAIL_IMAP_PASSWORD: "app-password",
} as unknown as NodeJS.ProcessEnv;

const EMPTY_ENV = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;

const REQUEST: ResendRequestSnapshot = {
  version: 1,
  idempotencyKey: "outreach/outreach-1/attempt-1",
  from: "Photo Admin <sender@example.com>",
  to: ["manager@example.com"],
  cc: ["assistant@example.com"],
  bcc: ["archive@example.com"],
  replyTo: ["reply@example.com"],
  subject: "Festival access",
  html: "<p>Hello manager</p>",
  text: "Hello manager",
  headers: {
    "X-Outreach-Id": "outreach-1",
    "X-Outreach-Attempt-Id": "attempt-1",
  },
  tags: [],
  attachments: [
    {
      filename: "credential.pdf",
      contentSha256: hashAttachmentContent(Buffer.from("pdf")),
      byteLength: 3,
      contentType: "application/pdf",
      contentId: null,
    },
  ],
};

test("Sent copy configuration supports Gmail, iCloud, and nonblocking failure capture", () => {
  assert.deepEqual(resolveSentMailCopyRequestState("false", null, EMPTY_ENV), {
    requested: false,
    targetScope: null,
    configurationError: null,
  });
  const missing = resolveSentMailCopyRequestState("true", null, EMPTY_ENV);
  assert.equal(missing.requested, true);
  assert.equal(missing.targetScope, null);
  assert.match(missing.configurationError ?? "", /SENT_MAIL_IMAP_HOST/);

  const missingPassword = resolveSentMailCopyRequestState("true", null, {
    ...ENV,
    SENT_MAIL_IMAP_PASSWORD: "",
  });
  assert.equal(missingPassword.requested, true);
  assert.match(
    missingPassword.targetScope ?? "",
    /^sent-mail:target-sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    missingPassword.configurationError ?? "",
    /SENT_MAIL_IMAP_PASSWORD/,
  );

  const gmail = getSentMailImapConfiguration(null, ENV);
  assert.equal(gmail.ok, true);
  if (gmail.ok) {
    assert.equal(gmail.config.provider, "gmail");
    assert.equal(gmail.config.mailbox, null);
    assert.equal(gmail.config.secure, true);
    assert.match(
      gmail.config.targetScope,
      /^sent-mail:target-sha256:[0-9a-f]{64}$/,
    );
  }
  const icloud = getSentMailImapConfiguration("Sent Messages", {
    ...ENV,
    SENT_MAIL_IMAP_HOST: "imap.mail.me.com",
  });
  assert.equal(icloud.ok, true);
  if (icloud.ok) {
    assert.equal(icloud.config.provider, "icloud");
    assert.equal(icloud.config.mailbox, "Sent Messages");
  }

  const plaintext = getSentMailImapConfiguration(null, {
    ...ENV,
    SENT_MAIL_IMAP_SECURE: "false",
  });
  assert.equal(plaintext.ok, false);
  if (!plaintext.ok) {
    assert.match(plaintext.error, /must be true/);
  }
});

test("Sent target scope excludes passwords and binds account and mailbox identity", () => {
  const original = getSentMailTarget(null, ENV);
  const rotatedPassword = getSentMailTarget(null, {
    ...ENV,
    SENT_MAIL_IMAP_PASSWORD: "rotated-password",
  });

  const normalizedUsername = getSentMailTarget(null, {
    ...ENV,
    SENT_MAIL_IMAP_USERNAME: "  sender@example.com  ",
  });
  const caseChangedUsername = getSentMailTarget(null, {
    ...ENV,
    SENT_MAIL_IMAP_USERNAME: "Sender@example.com",
  });
  const otherAccount = getSentMailTarget(null, {
    ...ENV,
    SENT_MAIL_IMAP_USERNAME: "other@example.com",
  });
  const otherMailbox = getSentMailTarget("[Gmail]/Other Sent", ENV);
  assert.equal(original.ok, true);
  assert.equal(rotatedPassword.ok, true);
  assert.equal(otherAccount.ok, true);
  assert.equal(otherMailbox.ok, true);
  if (
    original.ok &&
    rotatedPassword.ok &&
    normalizedUsername.ok &&
    caseChangedUsername.ok &&
    otherAccount.ok &&
    otherMailbox.ok
  ) {
    assert.equal(
      original.target.targetScope,
      rotatedPassword.target.targetScope,
    );
    assert.equal(
      original.target.targetScope,
      normalizedUsername.target.targetScope,
    );
    assert.notEqual(
      original.target.targetScope,
      caseChangedUsername.target.targetScope,
    );
    assert.notEqual(original.target.targetScope, otherAccount.target.targetScope);
    assert.notEqual(original.target.targetScope, otherMailbox.target.targetScope);
    assert.equal(
      original.target.targetScope.includes("sender@example.com"),
      false,
    );
  }
});

test("Sent target refresh is limited to proven-unsent pre-acceptance states", () => {
  const base = {
    status: "sending",
    providerMessageId: null,
    firstAttemptAt: new Date("2026-08-04T16:00:00.000Z"),
    attemptCount: 1,
    failureDisposition: null,
  };
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "prepared",
      firstAttemptAt: null,
      attemptCount: 0,
    }),
    true,
  );
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "queued",
      firstAttemptAt: null,
      attemptCount: 0,
    }),
    true,
  );
  for (const failureDisposition of [
    "configuration",
    "retryable",
    "permanent",
    "policy",
  ]) {
    assert.equal(
      canRefreshSentMailboxTargetBeforeSubmission({
        ...base,
        failureDisposition,
      }),
      true,
    );
  }
  for (const failureDisposition of ["in_flight", "uncertain", null]) {
    assert.equal(
      canRefreshSentMailboxTargetBeforeSubmission({
        ...base,
        failureDisposition,
      }),
      false,
    );
    assert.equal(
      canRefreshSentMailboxTargetBeforeSubmission({
        ...base,
        status: "request_failed",
        providerMessageId: "",
        providerMessageIds: ["", ""],
        providerRequestResults: [
          {
            providerMessageId: " \n ",
            failureDisposition: "retryable",
          },
        ],
        failureDisposition: "retryable",
      }),
      true,
    );
    assert.equal(
      canRefreshSentMailboxTargetBeforeSubmission({
        ...base,
        status: "request_failed",
        providerMessageId: "",
        providerMessageIds: ["", ""],
        providerRequestResults: [
          {
            providerMessageId: "accepted-result",
            failureDisposition: null,
          },
        ],
        failureDisposition: "retryable",
      }),
      false,
    );
    for (const providerRequestResults of [null, {}, ["malformed"]]) {
      assert.equal(
        canRefreshSentMailboxTargetBeforeSubmission({
          ...base,
          status: "request_failed",
          providerMessageId: "",
          providerMessageIds: [],
          providerRequestResults,
          failureDisposition: "retryable",
        }),
        true,
      );
    }
  }
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "request_failed",
      providerMessageId: "",
      providerMessageIds: ["", ""],
      failureDisposition: "retryable",
    }),
    true,
  );
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "request_failed",
      providerMessageId: " \t ",
      providerMessageIds: [],
      failureDisposition: "retryable",
    }),
    true,
  );
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "request_failed",
      providerMessageIds: ["accepted-message", ""],
      failureDisposition: "retryable",
    }),
    false,
  );
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      status: "sending",
      firstAttemptAt: null,
      attemptCount: 0,
    }),
    false,
  );
  assert.equal(
    canRefreshSentMailboxTargetBeforeSubmission({
      ...base,
      providerMessageId: "accepted-message",
      failureDisposition: "retryable",
    }),
    false,
  );
});

test("Sent copy MIME preserves immutable recipients, content, and attachments", async () => {
  const raw = await buildSentMailCopyMime(
    "outreach-attempt/attempt-1",
    "resend-message-1",
    REQUEST,
    hashResendRequestSnapshot(REQUEST),
    new Date("2026-08-04T16:00:00.000Z"),
    [
      {
        sha256: REQUEST.attachments[0].contentSha256,
        content: Uint8Array.from(Buffer.from("pdf")),
        byteLength: 3,
      },
    ],
  );
  const message = raw.toString("utf8");
  assert.match(
    message,
    /X-Photo-Admin-Sent-Copy-Id: outreach-attempt\/attempt-1/i,
  );
  assert.match(message, /X-Photo-Admin-Resend-Message-Id: resend-message-1/i);
  assert.match(message, /^Bcc: archive@example\.com$/im);
  assert.match(message, /^To: manager@example\.com$/im);
  assert.match(message, /credential\.pdf/);
  assert.match(message, /Hello manager/);

  await assert.rejects(
    buildSentMailCopyMime(
      "outreach-attempt/attempt-1",
      "resend-message-1",
      { ...REQUEST, subject: "Changed" },
      hashResendRequestSnapshot(REQUEST),
      new Date(),
      [],
    ),
    /integrity check/,
  );
});

class MemoryImapClient implements SentMailImapClient {
  usable = false;
  appendCount = 0;
  released = false;
  loggedOut = false;

  constructor(
    private readonly existing: number[],
    private readonly mailboxes = [
      {
        path: "[Gmail]/Sent Mail",
        pathAsListed: "[Gmail]/Sent Mail",
        name: "Sent Mail",
        delimiter: "/",
        parent: ["[Gmail]"],
        parentPath: "[Gmail]",
        flags: new Set<string>(),
        specialUse: "\\Sent",
        listed: true,
        subscribed: true,
      },
    ],
  ) {}

  async connect() {
    this.usable = true;
  }
  async list() {
    return this.mailboxes;
  }
  async getMailboxLock() {
    return {
      release: () => {
        this.released = true;
      },
    };
  }
  async search() {
    return this.existing;
  }
  async append(path: string) {
    this.appendCount += 1;
    return { destination: path, uid: 42, uidValidity: BigInt(7) };
  }
  async logout() {
    this.loggedOut = true;
    this.usable = false;
  }
  close() {
    this.usable = false;
  }
}

const CONFIG_RESULT = getSentMailImapConfiguration(null, ENV);
assert.equal(CONFIG_RESULT.ok, true);
const CONFIG = (CONFIG_RESULT as {
  ok: true;
  config: SentMailImapConfiguration;
}).config;

test("IMAP append searches the Sent mailbox first and is recovery-idempotent", async () => {
  const existing = new MemoryImapClient([99]);
  const recovered = await appendSentMailCopy(
    CONFIG,
    CONFIG.targetScope,
    "copy-1",
    Buffer.from("message"),
    new Date(),
    () => existing,
  );
  assert.equal(recovered.alreadyPresent, true);
  assert.equal(recovered.uid, 99);
  assert.equal(existing.appendCount, 0);
  assert.equal(existing.released, true);
  assert.equal(existing.loggedOut, true);

  const fresh = new MemoryImapClient([]);
  const appended = await appendSentMailCopy(
    CONFIG,
    CONFIG.targetScope,
    "copy-2",
    Buffer.from("message"),
    new Date(),
    () => fresh,
  );
  assert.equal(appended.alreadyPresent, false);
  assert.equal(appended.uid, 42);
  assert.equal(appended.uidValidity, BigInt(7));
  assert.equal(fresh.appendCount, 1);

  let created = false;
  const mismatchedScope = `${CONFIG.targetScope.slice(0, -1)}${
    CONFIG.targetScope.endsWith("0") ? "1" : "0"
  }`;
  await assert.rejects(
    appendSentMailCopy(
      CONFIG,
      mismatchedScope,
      "copy-mismatch",
      Buffer.from("message"),
      new Date(),
      () => {
        created = true;
        return new MemoryImapClient([]);
      },
    ),
    /does not match the immutable target/,
  );
  assert.equal(created, false);
});

test("IMAP deadline closes an unreachable connection before the route budget", async () => {
  let rejectConnect: ((error: Error) => void) | null = null;
  let closed = false;
  const client: SentMailImapClient = {
    usable: false,
    connect: async () => {
      client.usable = true;
      return new Promise<void>((_resolve, reject) => {
        rejectConnect = reject;
      });
    },
    list: async () => [],
    getMailboxLock: async () => ({ release() {} }),
    search: async () => [],
    append: async () => false,
    logout: async () => {},
    close: () => {
      closed = true;
      client.usable = false;
      rejectConnect?.(new Error("connection closed"));
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    appendSentMailCopy(
      CONFIG,
      CONFIG.targetScope,
      "deadline-copy",
      Buffer.from("message"),
      new Date(),
      () => client,
      { deadlineAtMs: startedAt + 25 },
    ),
    new RegExp(SENT_MAIL_COPY_DEADLINE_ERROR),
  );
  assert.equal(closed, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("Sent-copy batches stop before starting work without enough budget", async () => {
  let clock = 0;
  let queried = 0;
  const started: string[] = [];
  const dependencies: SentMailCopyBatchDependencies = {
    findDue: async () => {
      queried += 1;
      return ["one", "two", "three", "four"].map((id) => ({ id }));
    },
    dispatch: async (id) => {
      started.push(id);
      clock += 10_000;
      return { id, ok: true };
    },
  };
  const options = {
    deadlineAtMs: 30_000,
    minimumStartBudgetMs: 15_000,
    nowMs: () => clock,
  };
  assert.equal(hasSentMailCopyAttemptBudget(options), true);
  const results = await dispatchDueSentMailCopiesWithDependencies(
    5,
    new Date(0),
    options,
    dependencies,
  );
  assert.equal(queried, 1);
  assert.deepEqual(started, ["one", "two"]);
  assert.equal(results.length, 2);

  clock = 20_000;
  queried = 0;
  assert.equal(hasSentMailCopyAttemptBudget(options), false);
  assert.deepEqual(
    await dispatchDueSentMailCopiesWithDependencies(
      5,
      new Date(0),
      options,
      dependencies,
    ),
    [],
  );
  assert.equal(queried, 0);
});

test("deadline deferral releases the claim without consuming an attempt", () => {
  const now = new Date("2026-08-04T17:45:00.000Z");
  assert.deepEqual(sentMailCopyDeadlineReleaseData(now), {
    status: "retry_scheduled",
    error: "Sent copy deferred because the dispatcher deadline is near",
    nextAttemptAt: now,
    claimedAt: null,
    claimToken: null,
    attemptCount: { decrement: 1 },
  });
});

test("configuration, mismatch, and thrown failures share the bounded retry cap", () => {
  const now = new Date("2026-08-04T17:50:00.000Z");
  assert.deepEqual(
    sentMailCopyFailureState(SENT_MAIL_COPY_MAX_ATTEMPTS - 1, now),
    {
      terminal: false,
      status: "retry_scheduled",
      retryScheduled: true,
      nextAttemptAt: new Date("2026-08-04T18:50:00.000Z"),
    },
  );
  assert.deepEqual(sentMailCopyFailureState(SENT_MAIL_COPY_MAX_ATTEMPTS, now), {
    terminal: true,
    status: "manual_review",
    retryScheduled: false,
    nextAttemptAt: new Date("2026-08-04T18:50:00.000Z"),
  });
  const source = readFileSync(
    new URL("./sentMailCopy.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (
      source.match(
        /sentMailCopyFailureState\(claim\.attemptCount, now\)/g,
      ) ?? []
    ).length,
    3,
  );
});

test("stale crash recovery stops at the cap and reclaims only below it", () => {
  const staleBefore = new Date("2026-08-04T18:00:00.000Z");
  const staleClaimedAt = new Date("2026-08-04T17:59:59.000Z");
  assert.equal(
    sentMailCopyStaleRecovery(
      {
        status: "copying",
        claimedAt: staleClaimedAt,
        attemptCount: SENT_MAIL_COPY_MAX_ATTEMPTS,
      },
      staleBefore,
    ),
    "manual_review",
  );
  assert.equal(
    sentMailCopyStaleRecovery(
      {
        status: "copying",
        claimedAt: staleClaimedAt,
        attemptCount: SENT_MAIL_COPY_MAX_ATTEMPTS - 1,
      },
      staleBefore,
    ),
    "reclaim",
  );
  assert.equal(
    sentMailCopyStaleRecovery(
      {
        status: "copying",
        claimedAt: new Date("2026-08-04T18:00:01.000Z"),
        attemptCount: SENT_MAIL_COPY_MAX_ATTEMPTS,
      },
      staleBefore,
    ),
    null,
  );

  const source = readFileSync(
    new URL("./sentMailCopy.ts", import.meta.url),
    "utf8",
  );
  const claim = source.slice(
    source.indexOf("async function claimSentMailCopy"),
    source.indexOf("export function sentMailCopyDeadlineReleaseData"),
  );
  assert.match(
    claim,
    /staleRecovery === "manual_review"[\s\S]*status: "manual_review"[\s\S]*claimedAt: null[\s\S]*claimToken: null/,
  );
  assert.ok(
    claim.indexOf('staleRecovery === "manual_review"') <
      claim.indexOf("row.attemptCount + 1"),
  );
});

test("queueing excludes test or disabled sends and upserts one real source", async () => {
  const calls: unknown[] = [];
  const tx = {
    sentMailCopy: {
      upsert: async (args: {
        create: {
          id: string;
          providerMessageId: string;
          outreachAttemptId?: string;
          requestIndex?: number;
          arbitraryEmailId?: string;
          targetScope?: string | null;
          status?: string;
          error?: string | null;
        };
      }) => {
        calls.push(args);
        return {
          ...args.create,
          outreachAttemptId: args.create.outreachAttemptId ?? null,
          requestIndex: args.create.requestIndex ?? null,
          arbitraryEmailId: args.create.arbitraryEmailId ?? null,
        };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, "sentMailCopy">;
  await ensureSentMailCopyQueued(tx, {
    kind: "outreach",
    id: "attempt-disabled",
    requestIndex: 0,
    providerMessageId: "message-disabled",
    requested: false,
    targetScope: null,
    configurationError: null,
    testSend: false,
  });
  await ensureSentMailCopyQueued(tx, {
    kind: "arbitrary",
    id: "email-test",
    providerMessageId: "message-test",
    requested: true,
    targetScope: CONFIG.targetScope,
    configurationError: null,
    testSend: true,
  });
  await ensureSentMailCopyQueued(tx, {
    kind: "outreach",
    id: "attempt-real",
    requestIndex: 0,
    providerMessageId: "message-real",
    requested: true,
    targetScope: CONFIG.targetScope,
    configurationError:
      "Sent mailbox copy is enabled but SENT_MAIL_IMAP_PASSWORD is missing",
    testSend: false,
  });
  await ensureSentMailCopyQueued(tx, {
    kind: "arbitrary",
    id: "email-unbound",
    providerMessageId: "message-unbound",
    requested: true,
    targetScope: null,
    configurationError:
      "Sent mailbox copy is enabled but SENT_MAIL_IMAP_HOST is missing",
    testSend: false,
  });
  assert.equal(calls.length, 2);
  assert.match(
    JSON.stringify(calls[0]),
    /outreach-attempt\/attempt-real\/message\/0/,
  );
  assert.match(JSON.stringify(calls[0]), /retry_scheduled/);
  assert.match(JSON.stringify(calls[0]), /sent-mail:target-sha256/);
  assert.match(JSON.stringify(calls[1]), /manual_review/);
  assert.match(JSON.stringify(calls[1]), /SENT_MAIL_IMAP_HOST/);
});

test("outreach batches queue one immutable Sent copy per provider request", async () => {
  const calls: Array<{
    where: { id: string };
    create: {
      id: string;
      outreachAttemptId?: string;
      requestIndex?: number;
      providerMessageId: string;
      targetScope?: string | null;
    };
  }> = [];
  const tx = {
    sentMailCopy: {
      upsert: async (args: (typeof calls)[number]) => {
        calls.push(args);
        return {
          ...args.create,
          outreachAttemptId: args.create.outreachAttemptId ?? null,
          requestIndex: args.create.requestIndex ?? null,
          arbitraryEmailId: null,
          targetScope: args.create.targetScope ?? null,
        };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, "sentMailCopy">;

  await ensureOutreachSentMailCopiesQueued(tx, {
    id: "attempt-batch",
    providerMessageIds: ["message-a", "message-b"],
    requested: true,
    targetScope: CONFIG.targetScope,
    configurationError: null,
    testSend: false,
  });

  assert.deepEqual(
    calls.map((call) => ({
      id: call.create.id,
      requestIndex: call.create.requestIndex,
      providerMessageId: call.create.providerMessageId,
    })),
    [
      {
        id: "outreach-attempt/attempt-batch/message/0",
        requestIndex: 0,
        providerMessageId: "message-a",
      },
      {
        id: "outreach-attempt/attempt-batch/message/1",
        requestIndex: 1,
        providerMessageId: "message-b",
      },
    ],
  );
});

test("all accepted outbound and reconciliation paths enqueue Sent copies", () => {
  const outreach = readFileSync(
    new URL("./sendOutreach.ts", import.meta.url),
    "utf8",
  );
  const arbitrary = readFileSync(
    new URL("./sendArbitraryEmail.ts", import.meta.url),
    "utf8",
  );
  const webhook = readFileSync(
    new URL("../app/api/resend/webhook/route.ts", import.meta.url),
    "utf8",
  );
  const cron = readFileSync(
    new URL("../app/api/cron/send-scheduled/route.ts", import.meta.url),
    "utf8",
  );
  const sentCopy = readFileSync(
    new URL("./sentMailCopy.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    (outreach.match(/ensureOutreachSentMailCopiesQueued\(/g) ?? []).length >=
      2,
  );
  assert.ok((arbitrary.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok((webhook.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 1);
  assert.ok(
    (webhook.match(/ensureOutreachSentMailCopiesQueued\(/g) ?? []).length >= 1,
  );
  assert.ok(
    (webhook.match(/targetScope: .*sentMailboxTargetScope/g) ?? []).length >= 2,
  );
  assert.ok(
    (webhook.match(/sentMailboxCopyConfigurationError/g) ?? []).length >= 2,
  );
  assert.match(cron, /dispatchDueSentMailCopies\(/);
  assert.ok(
    sentCopy.indexOf(
      "configuration.config.targetScope !== loaded.row.targetScope",
    ) < sentCopy.indexOf("await appendSentMailCopy("),
  );
});

test("Sent copy persistence constrains one immutable source and retry state", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260804163000_sent_mail_copy/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CONSTRAINT "SentMailCopy_source_check"/);
  assert.match(migration, /CONSTRAINT "SentMailCopy_status_check"/);
  assert.match(migration, /SentMailCopy_identity_immutable/);
  assert.match(migration, /sentMailboxCopyRequested/);
  assert.match(migration, /COMMIT;\s*$/);

  const scopeMigration = readFileSync(
    new URL(
      "../prisma/migrations/20260804174500_sent_mail_target_scope/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(scopeMigration, /^BEGIN;/);
  assert.match(scopeMigration, /SentMailCopy_targetScope_format_check/);
  assert.match(scopeMigration, /SentMailCopy_targetScope_status_check/);
  assert.match(scopeMigration, /SentMailCopy_normalize_unbound_insert/);
  assert.match(scopeMigration, /targetScope" IS DISTINCT FROM OLD\."targetScope/);
  assert.match(scopeMigration, /sentMailboxCopyConfigurationError/);
  assert.match(scopeMigration, /COMMIT;\s*$/);

  const refreshMigration = readFileSync(
    new URL(
      "../prisma/migrations/20260804181500_sent_mail_retry_target_refresh/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(refreshMigration, /^BEGIN;/);
  assert.match(refreshMigration, /failureDisposition" IN/);
  assert.match(refreshMigration, /status" IN \('prepared', 'queued'\)/);
  assert.doesNotMatch(refreshMigration, /'in_flight'|'uncertain'/);
  assert.match(refreshMigration, /possible provider acceptance/);
  assert.match(refreshMigration, /COMMIT;\s*$/);

  const immediateMigration = readFileSync(
    new URL(
      "../prisma/migrations/20260804193000_immediate_arbitrary_sent_target/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(immediateMigration, /^BEGIN;/);
  assert.match(
    immediateMigration,
    /status" = 'sending'[\s\S]*claimedAt" IS NULL[\s\S]*claimToken" IS NULL/,
  );
  assert.match(immediateMigration, /possible provider acceptance/);
  assert.match(immediateMigration, /COMMIT;\s*$/);

  const batchMigration = readFileSync(
    new URL(
      "../prisma/migrations/20260805004500_sent_mail_batch_copies/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(batchMigration, /^BEGIN;/);
  assert.match(batchMigration, /ADD COLUMN "requestIndex" INTEGER/);
  assert.match(
    batchMigration,
    /SentMailCopy_outreachAttemptId_requestIndex_key/,
  );
  assert.doesNotMatch(
    batchMigration,
    /cardinality\(OLD\."providerMessageIds"\) > 0/,
  );
  assert.doesNotMatch(
    batchMigration,
    /OLD\."providerMessageId" IS NOT NULL/,
  );
  assert.match(
    batchMigration,
    /NULLIF\(btrim\(OLD\."providerMessageId"\), ''\) IS NOT NULL/,
  );
  assert.match(
    batchMigration,
    /unnest\([\s\S]*providerMessageIds[\s\S]*NULLIF\(btrim\("providerMessageIdValue"\), ''\) IS NOT NULL/,
  );
  assert.match(
    batchMigration,
    /jsonb_array_elements\([\s\S]*jsonb_typeof\(OLD\."providerRequestResults"\) = 'array'[\s\S]*providerRequestResult" ->> 'providerMessageId'[\s\S]*IS NOT NULL/,
  );
  assert.match(batchMigration, /COMMIT;\s*$/);
});
