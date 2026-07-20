import assert from "node:assert/strict";
import test from "node:test";
import { acquireOutreachRecipientPolicyLocks } from "./outreachPolicyLocks";
import {
  buildArbitraryResendDeliveryPolicy,
  hashResendRequestSnapshot,
  type PrepareArbitraryResendRequestArgs,
  type PrepareResendRequestResult,
  type ResendDeliverySettingsSnapshot,
  type ResendRequestSnapshot,
} from "./resend";
import {
  sendArbitraryEmailWithDependencies,
  type SendArbitraryEmailDependencies,
} from "./sendArbitraryEmail";

class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

interface MemoryTransaction {
  releases: Array<() => void>;
  $queryRaw: (query: { text: string; values: unknown[] }) => Promise<unknown[]>;
  arbitraryEmail: {
    findUnique: () => Promise<Record<string, unknown> | null>;
    update: (args: { data: Record<string, unknown> }) => Promise<void>;
  };
  emailSuppression: {
    findMany: (args: {
      where: { normalizedEmail: { in: string[] } };
    }) => Promise<Array<{ normalizedEmail: string }>>;
  };
}

class MemoryArbitraryEmailDatabase {
  record: Record<string, unknown> | null = null;
  readonly suppressed = new Set<string>();
  readonly settingsMutex = new Mutex();
  private readonly recipientMutexes = new Map<string, Mutex>();

  readonly arbitraryEmail: {
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
    updateMany: (args: {
      where: { id: string; status?: string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };

  constructor() {
    this.arbitraryEmail = {
      create: async (args: { data: Record<string, unknown> }) => {
        this.record = { ...args.data };
        return this.record;
      },
      updateMany: async (args: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (
          this.record?.id === args.where.id &&
          (!args.where.status || this.record.status === args.where.status)
        ) {
          Object.assign(this.record, args.data);
          return { count: 1 };
        }
        return { count: 0 };
      },
    };
  }

  async $transaction<T>(
    work: (tx: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    const tx: MemoryTransaction = {
      releases,
      $queryRaw: async (query) => {
        if (query.text.includes("pg_advisory_xact_lock")) {
          const email = String(query.values[1]);
          let mutex = this.recipientMutexes.get(email);
          if (!mutex) {
            mutex = new Mutex();
            this.recipientMutexes.set(email, mutex);
          }
          releases.push(await mutex.acquire());
        }
        return [];
      },
      arbitraryEmail: {
        findUnique: async () => this.record,
        update: async ({ data }) => {
          assert.ok(this.record);
          Object.assign(this.record, data);
        },
      },
      emailSuppression: {
        findMany: async ({ where }) =>
          where.normalizedEmail.in
            .filter((email) => this.suppressed.has(email))
            .map((normalizedEmail) => ({ normalizedEmail })),
      },
    };
    try {
      return await work(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async holdSuppression(email: string): Promise<{
    release: () => void;
    completed: Promise<void>;
  }> {
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = this.$transaction(async (tx) => {
      await acquireOutreachRecipientPolicyLocks(
        tx as never,
        [email],
      );
      this.suppressed.add(email);
      locked();
      await gate;
    });
    await ready;
    return { release, completed };
  }
}

const INPUT = {
  recipientEmails: ["first@example.com", "second@example.com"],
  subject: "Private update",
  html: "<p>Hello</p>",
  utm: {
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    utm_content: "",
    utm_term: "",
  },
};

function prepareWithSettings(
  settings: ResendDeliverySettingsSnapshot,
): (args: PrepareArbitraryResendRequestArgs) => Promise<PrepareResendRequestResult> {
  return async (args) => {
    const resolved = buildArbitraryResendDeliveryPolicy({
      from: settings.from,
      intendedRecipients: args.to,
      subject: args.subject,
      testOverride: settings.testOverride,
      bccEmails: settings.bccEmails,
      suppressedEmails: [],
    });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    const request: ResendRequestSnapshot = {
      version: 1,
      idempotencyKey: args.idempotencyKey,
      from: resolved.policy.from,
      to: resolved.policy.to,
      cc: [],
      bcc: resolved.policy.bcc,
      replyTo: [],
      subject: resolved.policy.subject,
      html: args.html,
      headers: { "X-Arbitrary-Email-Id": args.arbitraryEmailId },
      tags: [{ name: "arbitrary_email_id", value: args.arbitraryEmailId }],
      attachments: [],
    };
    return {
      ok: true,
      request,
      requestHash: hashResendRequestSnapshot(request),
      testSend: resolved.policy.testSend,
      intendedRecipients: resolved.policy.intendedRecipients,
      attachmentBlobs: [],
      warnings: [],
      rateCardAttachmentOmitted: false,
    };
  };
}

function dependencies(
  database: MemoryArbitraryEmailDatabase,
  settings: ResendDeliverySettingsSnapshot,
  submit: SendArbitraryEmailDependencies["submit"],
  preparationSettings: ResendDeliverySettingsSnapshot = settings,
): SendArbitraryEmailDependencies {
  return {
    database: database as unknown as SendArbitraryEmailDependencies["database"],
    createId: () => "arbitrary-1",
    now: () => new Date("2026-07-20T20:00:00Z"),
    prepare: prepareWithSettings({ ...preparationSettings }),
    getDeliverySettings: async (tx) => {
      const release = await database.settingsMutex.acquire();
      (tx as unknown as MemoryTransaction).releases.push(release);
      return {
        ...settings,
        bccEmails: [...settings.bccEmails],
      };
    },
    acquireRecipientLocks: acquireOutreachRecipientPolicyLocks,
    submit,
  };
}

const REAL_SETTINGS: ResendDeliverySettingsSnapshot = {
  apiKey: "re_test",
  credentialScope: "unused-by-arbitrary-send",
  from: "Photo Admin <sender@example.com>",
  testOverride: null,
  bccEmails: ["audit@example.com"],
};

test("a suppression that wins the recipient lock blocks the stale real request", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const suppression = await database.holdSuppression("first@example.com");
  let submissions = 0;
  const send = sendArbitraryEmailWithDependencies(
    INPUT,
    dependencies(database, REAL_SETTINGS, async () => {
      submissions += 1;
      return {
        providerMessageId: "message-1",
        error: null,
        failureDisposition: null,
      };
    }),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
  suppression.release();
  await suppression.completed;

  const result = await send;
  assert.equal(result.ok, false);
  assert.equal(submissions, 0);
  assert.match(String(database.record?.error), /immutable request/);
});

test("a test-mode write that wins the settings lock blocks the stale real request", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const settings = { ...REAL_SETTINGS };
  const releaseSettings = await database.settingsMutex.acquire();
  settings.testOverride = "test@example.com";
  let submissions = 0;
  const send = sendArbitraryEmailWithDependencies(
    INPUT,
    dependencies(database, settings, async () => {
      submissions += 1;
      return {
        providerMessageId: "message-1",
        error: null,
        failureDisposition: null,
      };
    }, REAL_SETTINGS),
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(submissions, 0);
  releaseSettings();

  const result = await send;
  assert.equal(result.ok, false);
  assert.equal(submissions, 0);
  assert.match(String(database.record?.error), /test mode is now enabled/);
});

test("settings and recipient locks remain held through provider submission", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const settings = { ...REAL_SETTINGS };
  let providerEntered!: () => void;
  const providerReady = new Promise<void>((resolve) => {
    providerEntered = resolve;
  });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const send = sendArbitraryEmailWithDependencies(
    INPUT,
    dependencies(database, settings, async (request) => {
      assert.deepEqual(request.to, ["sender@example.com"]);
      assert.deepEqual(request.bcc, [
        "audit@example.com",
        "first@example.com",
        "second@example.com",
      ]);
      providerEntered();
      await providerGate;
      return {
        providerMessageId: "message-1",
        error: null,
        failureDisposition: null,
      };
    }),
  );
  await providerReady;

  let settingChanged = false;
  const settingMutation = (async () => {
    const release = await database.settingsMutex.acquire();
    settings.testOverride = "test@example.com";
    settingChanged = true;
    release();
  })();
  let suppressionChanged = false;
  const suppressionMutation = database
    .holdSuppression("first@example.com")
    .then(({ release, completed }) => {
      suppressionChanged = true;
      release();
      return completed;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settingChanged, false);
  assert.equal(suppressionChanged, false);

  releaseProvider();
  const result = await send;
  await Promise.all([settingMutation, suppressionMutation]);
  assert.deepEqual(result, {
    ok: true,
    id: "arbitrary-1",
    testSend: false,
  });
  assert.equal(settingChanged, true);
  assert.equal(suppressionChanged, true);
  assert.deepEqual(database.record?.recipientEmails, [
    "first@example.com",
    "second@example.com",
  ]);
});

test("uncertain provider outcomes retain the immutable request for manual review", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const result = await sendArbitraryEmailWithDependencies(
    INPUT,
    dependencies(database, REAL_SETTINGS, async () => ({
      providerMessageId: null,
      error: "provider connection closed",
      failureDisposition: "uncertain",
    })),
  );

  assert.deepEqual(result, {
    ok: false,
    error: "provider connection closed",
  });
  assert.equal(database.record?.status, "manual_review");
  assert.equal(
    database.record?.idempotencyKey,
    "arbitrary-email/arbitrary-1",
  );
  assert.equal(typeof database.record?.providerRequest, "object");
  assert.match(String(database.record?.requestHash), /^[0-9a-f]{64}$/);
});
