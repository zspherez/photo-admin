import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  appendSentMailCopy,
  buildSentMailCopyMime,
  ensureSentMailCopyQueued,
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

test("queueing excludes test or disabled sends and upserts one real source", async () => {
  const calls: unknown[] = [];
  const tx = {
    sentMailCopy: {
      upsert: async (args: {
        create: {
          id: string;
          providerMessageId: string;
          outreachAttemptId?: string;
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
          arbitraryEmailId: args.create.arbitraryEmailId ?? null,
        };
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, "sentMailCopy">;
  await ensureSentMailCopyQueued(tx, {
    kind: "outreach",
    id: "attempt-disabled",
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
  assert.match(JSON.stringify(calls[0]), /outreach-attempt\/attempt-real/);
  assert.match(JSON.stringify(calls[0]), /retry_scheduled/);
  assert.match(JSON.stringify(calls[0]), /sent-mail:target-sha256/);
  assert.match(JSON.stringify(calls[1]), /manual_review/);
  assert.match(JSON.stringify(calls[1]), /SENT_MAIL_IMAP_HOST/);
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
  assert.ok((outreach.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok((arbitrary.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok((webhook.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok(
    (webhook.match(/targetScope: .*sentMailboxTargetScope/g) ?? []).length >= 2,
  );
  assert.ok(
    (webhook.match(/sentMailboxCopyConfigurationError/g) ?? []).length >= 2,
  );
  assert.match(cron, /dispatchDueSentMailCopies\(/);
  assert.match(
    sentCopy,
    /!configuration\.ok[\s\S]*status: "retry_scheduled"[\s\S]*retryScheduled: true/,
  );
  assert.match(
    sentCopy,
    /configuration\.config\.targetScope !== loaded\.row\.targetScope[\s\S]*does not match the immutable target[\s\S]*status: "retry_scheduled"/,
  );
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
});
