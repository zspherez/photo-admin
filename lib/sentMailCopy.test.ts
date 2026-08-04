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

test("Sent copy configuration supports Gmail, iCloud, and fail-closed enablement", () => {
  assert.deepEqual(resolveSentMailCopyRequestState("false", null, EMPTY_ENV), {
    requested: false,
    configurationError: null,
  });
  const missing = resolveSentMailCopyRequestState("true", null, EMPTY_ENV);
  assert.equal(missing.requested, true);
  assert.match(missing.configurationError ?? "", /SENT_MAIL_IMAP_HOST/);

  const gmail = getSentMailImapConfiguration(null, ENV);
  assert.equal(gmail.ok, true);
  if (gmail.ok) {
    assert.equal(gmail.config.provider, "gmail");
    assert.equal(gmail.config.mailbox, null);
    assert.equal(gmail.config.secure, true);
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

const CONFIG: SentMailImapConfiguration = {
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  username: "sender@example.com",
  password: "app-password",
  mailbox: null,
  provider: "gmail",
};

test("IMAP append searches the Sent mailbox first and is recovery-idempotent", async () => {
  const existing = new MemoryImapClient([99]);
  const recovered = await appendSentMailCopy(
    CONFIG,
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
    "copy-2",
    Buffer.from("message"),
    new Date(),
    () => fresh,
  );
  assert.equal(appended.alreadyPresent, false);
  assert.equal(appended.uid, 42);
  assert.equal(appended.uidValidity, BigInt(7));
  assert.equal(fresh.appendCount, 1);
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
    testSend: false,
  });
  await ensureSentMailCopyQueued(tx, {
    kind: "arbitrary",
    id: "email-test",
    providerMessageId: "message-test",
    requested: true,
    testSend: true,
  });
  await ensureSentMailCopyQueued(tx, {
    kind: "outreach",
    id: "attempt-real",
    providerMessageId: "message-real",
    requested: true,
    testSend: false,
  });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /outreach-attempt\/attempt-real/);
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
  assert.ok((outreach.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok((arbitrary.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.ok((webhook.match(/ensureSentMailCopyQueued\(/g) ?? []).length >= 2);
  assert.match(cron, /dispatchDueSentMailCopies\(/);
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
});
