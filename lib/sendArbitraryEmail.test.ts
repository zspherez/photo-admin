import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { acquireOutreachRecipientPolicyLocks } from "./outreachPolicyLocks";
import {
  buildArbitraryResendDeliveryPolicy,
  getResendCredentialScope,
  hashResendRequestSnapshot,
  type PrepareArbitraryResendRequestArgs,
  type PrepareResendRequestResult,
  type ResendDeliverySettingsSnapshot,
  type ResendRequestSnapshot,
} from "./resend";
import {
  cancelScheduledArbitraryEmailWithDatabase,
  dispatchScheduledArbitraryEmailWithDependencies,
  queueArbitraryEmailWithDependencies,
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
    findFirst: () => Promise<Record<string, unknown> | null>;
    findUnique: () => Promise<Record<string, unknown> | null>;
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
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
  createCount = 0;
  transactionFailuresRemaining = 0;
  readonly suppressed = new Set<string>();
  readonly settingsMutex = new Mutex();
  readonly transactionMutex = new Mutex();
  private readonly recipientMutexes = new Map<string, Mutex>();

  readonly arbitraryEmail: {
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
    findUnique: (args: {
      where: { id: string };
    }) => Promise<Record<string, unknown> | null>;
  };

  constructor() {
    this.arbitraryEmail = {
      create: async (args: { data: Record<string, unknown> }) => {
        this.createCount += 1;
        this.record = this.normalizedData(args.data);
        return this.record;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (this.matches(args.where)) {
          this.applyData(args.data);
          return { count: 1 };
        }
        return { count: 0 };
      },
      findUnique: async ({ where }) =>
        this.record?.id === where.id ? this.record : null,
    };
  }

  private normalizedData(data: Record<string, unknown>): Record<string, unknown> {
    return {
      providerMessageId: null,
      claimedAt: null,
      claimToken: null,
      lastAttemptAt: null,
      firstAttemptAt: null,
      attemptCount: 0,
      failureDisposition: null,
      providerCredentialScope: null,
      sentAt: null,
      ...Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          value === Prisma.DbNull ? null : value,
        ]),
      ),
    };
  }

  private matches(where: Record<string, unknown>): boolean {
    if (!this.record) return false;
    for (const [key, expected] of Object.entries(where)) {
      const actual = this.record[key];
      if (
        expected &&
        typeof expected === "object" &&
        !Array.isArray(expected)
      ) {
        if ("in" in expected) {
          if (!(expected.in as unknown[]).includes(actual)) return false;
          continue;
        }
        if ("equals" in expected) {
          if (actual !== null) return false;
          continue;
        }
      }
      if (actual !== expected) return false;
    }
    return true;
  }

  private applyData(data: Record<string, unknown>): void {
    assert.ok(this.record);
    for (const [key, value] of Object.entries(data)) {
      if (
        value &&
        typeof value === "object" &&
        "increment" in value
      ) {
        this.record[key] =
          Number(this.record[key] ?? 0) + Number(value.increment);
      } else {
        this.record[key] = value;
      }
    }
  }

  async $transaction<T>(
    work: (tx: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.transactionFailuresRemaining > 0) {
      this.transactionFailuresRemaining -= 1;
      throw new Prisma.PrismaClientKnownRequestError("retry transaction", {
        code: "P2034",
        clientVersion: "test",
      });
    }
    const releases: Array<() => void> = [
      await this.transactionMutex.acquire(),
    ];
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
        findFirst: async () => this.record,
        findUnique: async () => this.record,
        create: async ({ data }) => {
          this.createCount += 1;
          this.record = this.normalizedData(data);
          return this.record;
        },
        update: async ({ data }) => {
          this.applyData(data);
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
  text: "Hello",
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
      text: args.text,
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

test("transaction retries submit the immutable canonical HTML and text snapshot", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  database.transactionFailuresRemaining = 1;
  let preparationCalls = 0;
  let submittedRequest: ResendRequestSnapshot | null = null;
  const deps = dependencies(database, REAL_SETTINGS, async (request) => {
    submittedRequest = request;
    return {
      providerMessageId: "message-retry",
      error: null,
      failureDisposition: null,
    };
  });
  const prepare = deps.prepare;
  deps.prepare = async (args) => {
    preparationCalls += 1;
    return prepare(args);
  };

  const result = await sendArbitraryEmailWithDependencies(
    {
      ...INPUT,
      html:
        '<html><head><meta charset="utf-16"></head><body><p onclick="bad()">Hello <a href="https://example.com?a=1">there</a></p></body></html>',
      text: "ignored caller text",
      utm: { ...INPUT.utm, utm_source: "newsletter" },
    },
    deps,
  );

  assert.equal(result.ok, true);
  assert.equal(preparationCalls, 1);
  const submitted = submittedRequest as ResendRequestSnapshot | null;
  assert.ok(submitted);
  assert.deepEqual(submitted, database.record?.providerRequest);
  assert.equal(database.record?.html, submitted.html);
  assert.equal(database.record?.text, submitted.text);
  assert.ok(submitted.html.startsWith("<!doctype html>"));
  assert.doesNotMatch(submitted.html, /onclick|utf-16/);
  assert.match(submitted.html, /utm_source=newsletter/);
  assert.match(submitted.text ?? "", /Hello there \(https:\/\/example\.com/);
});

test("duplicate queue clicks create one immutable scheduled record", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const scheduledFor = new Date("2026-07-21T13:00:00.000Z");
  const queue = () =>
    queueArbitraryEmailWithDependencies(
      {
        ...INPUT,
        html: '<p>Hello <a href="https://example.com">there</a></p>',
        utm: { ...INPUT.utm, utm_source: "newsletter" },
      },
      scheduledFor,
      "5af59522-8b35-4ce8-b916-c530438030db",
      {
        database:
          database as unknown as SendArbitraryEmailDependencies["database"],
        now: () => new Date("2026-07-20T12:00:00.000Z"),
      },
    );

  const [first, second] = await Promise.all([queue(), queue()]);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(database.createCount, 1);
  assert.equal(database.record?.status, "scheduled");
  assert.equal(database.record?.providerRequest, null);
  assert.match(String(database.record?.html), /utm_source=newsletter/);
  assert.match(String(database.record?.text), /Hello there/);
});

test("concurrent morning claims submit an overdue queued record once", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  const settings = { ...REAL_SETTINGS };
  let submissions = 0;
  let submittedRequest: ResendRequestSnapshot | null = null;
  const deps = dependencies(database, settings, async (request) => {
    submissions += 1;
    submittedRequest = request;
    return {
      providerMessageId: "message-queued",
      error: null,
      failureDisposition: null,
    };
  });
  deps.now = () => now.value;
  deps.createId = (() => {
    let value = 0;
    return () => `claim-${++value}`;
  })();

  const queued = await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "d7a349d7-bc75-46d8-a8d0-5a61d650cf49",
    deps,
  );
  assert.equal(queued.ok, true);
  now.value = new Date("2026-07-20T13:00:01.000Z");

  const [first, second] = await Promise.all([
    dispatchScheduledArbitraryEmailWithDependencies(
      "d7a349d7-bc75-46d8-a8d0-5a61d650cf49",
      deps,
    ),
    dispatchScheduledArbitraryEmailWithDependencies(
      "d7a349d7-bc75-46d8-a8d0-5a61d650cf49",
      deps,
    ),
  ]);

  assert.equal(submissions, 1);
  assert.ok(first.ok || second.ok);
  assert.ok(first.skipped || second.skipped);
  assert.equal(database.record?.status, "sent");
  assert.equal(
    database.record?.providerCredentialScope,
    getResendCredentialScope(settings.apiKey),
  );
  assert.ok(database.record?.firstAttemptAt instanceof Date);
  assert.deepEqual(database.record?.recipientEmails, INPUT.recipientEmails);
  const submitted = submittedRequest as ResendRequestSnapshot | null;
  assert.ok(submitted);
  assert.equal(database.record?.html, submitted.html);
  assert.equal(database.record?.text, submitted.text);
});

test("scheduled retries retain their committed credential scope", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  const settings = { ...REAL_SETTINGS, apiKey: "re_same_scope" };
  let submissions = 0;
  let scopeAtFirstSubmission: unknown;
  const deps = dependencies(database, settings, async () => {
    submissions += 1;
    scopeAtFirstSubmission ??= database.record?.providerCredentialScope;
    return submissions === 1
      ? {
          providerMessageId: null,
          error: "temporary provider outage",
          failureDisposition: "retryable",
        }
      : {
          providerMessageId: "message-retried",
          error: null,
          failureDisposition: null,
        };
  });
  deps.now = () => now.value;
  const id = "d9bde2a6-8c6b-4424-9907-14cdb46867a2";
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    id,
    deps,
  );
  now.value = new Date("2026-07-20T13:00:01.000Z");
  const first = await dispatchScheduledArbitraryEmailWithDependencies(id, deps);
  assert.equal(first.retryScheduled, true);
  const committedScope = getResendCredentialScope(settings.apiKey);
  assert.equal(scopeAtFirstSubmission, committedScope);
  assert.equal(database.record?.providerCredentialScope, committedScope);
  const firstAttemptAt = database.record?.firstAttemptAt;

  now.value = new Date("2026-07-20T13:01:01.000Z");
  const second = await dispatchScheduledArbitraryEmailWithDependencies(id, deps);
  assert.equal(second.ok, true);
  assert.equal(submissions, 2);
  assert.equal(database.record?.providerCredentialScope, committedScope);
  assert.equal(database.record?.firstAttemptAt, firstAttemptAt);
});

test("credential rotation after an in-flight scheduled attempt fails closed", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  const settings = { ...REAL_SETTINGS, apiKey: "re_initial_scope" };
  let submissions = 0;
  const deps = dependencies(database, settings, async () => {
    submissions += 1;
    return {
      providerMessageId: null,
      error: "provider may still be processing",
      failureDisposition: "in_flight",
    };
  });
  deps.now = () => now.value;
  const id = "091abfac-ca35-40f7-9d1a-457c2028c12d";
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    id,
    deps,
  );
  now.value = new Date("2026-07-20T13:00:01.000Z");
  const first = await dispatchScheduledArbitraryEmailWithDependencies(id, deps);
  assert.equal(first.retryScheduled, true);
  const originalScope = database.record?.providerCredentialScope;

  settings.apiKey = "re_rotated_scope";
  now.value = new Date("2026-07-20T13:01:01.000Z");
  const rotated = await dispatchScheduledArbitraryEmailWithDependencies(
    id,
    deps,
  );
  assert.equal(rotated.ok, false);
  assert.equal(submissions, 1);
  assert.equal(database.record?.status, "manual_review");
  assert.equal(database.record?.providerCredentialScope, originalScope);
  assert.match(String(database.record?.error), /credential scope changed/i);
});

test("uncertain scheduled outcomes retain credential scope for manual review", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  const settings = { ...REAL_SETTINGS, apiKey: "re_uncertain_scope" };
  const deps = dependencies(database, settings, async () => ({
    providerMessageId: null,
    error: "provider connection closed",
    failureDisposition: "uncertain",
  }));
  deps.now = () => now.value;
  const id = "4cc419bf-26a9-47f0-b09a-42d58dd34bc6";
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    id,
    deps,
  );
  now.value = new Date("2026-07-20T13:00:01.000Z");
  const result = await dispatchScheduledArbitraryEmailWithDependencies(id, deps);
  assert.equal(result.ok, false);
  assert.equal(database.record?.status, "manual_review");
  assert.equal(database.record?.failureDisposition, "uncertain");
  assert.equal(
    database.record?.providerCredentialScope,
    getResendCredentialScope(settings.apiKey),
  );
  assert.ok(database.record?.firstAttemptAt instanceof Date);
});

test("dispatch rechecks suppression and test override without replacing intended recipients", async () => {
  const suppressedDatabase = new MemoryArbitraryEmailDatabase();
  const suppressedNow = {
    value: new Date("2026-07-20T12:00:00.000Z"),
  };
  let suppressedSubmissions = 0;
  const suppressedDeps = dependencies(
    suppressedDatabase,
    REAL_SETTINGS,
    async () => {
      suppressedSubmissions += 1;
      return {
        providerMessageId: "should-not-send",
        error: null,
        failureDisposition: null,
      };
    },
  );
  suppressedDeps.now = () => suppressedNow.value;
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "861981d1-cc2c-4293-9ecf-a8e4919dd60d",
    suppressedDeps,
  );
  suppressedDatabase.suppressed.add("first@example.com");
  suppressedNow.value = new Date("2026-07-20T13:00:01.000Z");
  const suppressedResult =
    await dispatchScheduledArbitraryEmailWithDependencies(
      "861981d1-cc2c-4293-9ecf-a8e4919dd60d",
      suppressedDeps,
    );
  assert.equal(suppressedResult.ok, false);
  assert.equal(suppressedSubmissions, 0);
  assert.match(String(suppressedDatabase.record?.error), /policy/);

  const overrideDatabase = new MemoryArbitraryEmailDatabase();
  const overrideNow = { value: new Date("2026-07-20T12:00:00.000Z") };
  const overrideSettings = {
    ...REAL_SETTINGS,
    testOverride: "test@example.com",
  };
  let overrideRequest: ResendRequestSnapshot | null = null;
  const overrideDeps = dependencies(
    overrideDatabase,
    overrideSettings,
    async (request) => {
      overrideRequest = request;
      return {
        providerMessageId: "test-message",
        error: null,
        failureDisposition: null,
      };
    },
  );
  overrideDeps.now = () => overrideNow.value;
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "87e8bcdf-f112-47cc-bd83-b8bc57f2c1fb",
    overrideDeps,
  );
  overrideNow.value = new Date("2026-07-20T13:00:01.000Z");
  const overrideResult = await dispatchScheduledArbitraryEmailWithDependencies(
    "87e8bcdf-f112-47cc-bd83-b8bc57f2c1fb",
    overrideDeps,
  );
  assert.equal(overrideResult.ok, true);
  const overridden = overrideRequest as ResendRequestSnapshot | null;
  assert.ok(overridden);
  assert.deepEqual(overridden.to, ["test@example.com"]);
  assert.deepEqual(overrideDatabase.record?.recipientEmails, INPUT.recipientEmails);
  assert.equal(overrideDatabase.record?.testSend, true);
  assert.equal(overrideDatabase.record?.status, "test");
});

test("recovery reclaims a stale queued arbitrary email exactly once", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  let submissions = 0;
  const deps = dependencies(database, REAL_SETTINGS, async () => {
    submissions += 1;
    return {
      providerMessageId: "recovered-message",
      error: null,
      failureDisposition: null,
    };
  });
  deps.now = () => now.value;
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "6a88571a-eb0c-49ed-bb63-9ea7ad224478",
    deps,
  );
  Object.assign(database.record!, {
    status: "queued",
    claimedAt: new Date("2026-07-20T12:30:00.000Z"),
    claimToken: "stale-claim",
  });
  now.value = new Date("2026-07-20T13:00:01.000Z");

  const [first, second] = await Promise.all([
    dispatchScheduledArbitraryEmailWithDependencies(
      "6a88571a-eb0c-49ed-bb63-9ea7ad224478",
      deps,
    ),
    dispatchScheduledArbitraryEmailWithDependencies(
      "6a88571a-eb0c-49ed-bb63-9ea7ad224478",
      deps,
    ),
  ]);
  assert.equal(submissions, 1);
  assert.ok(first.ok || second.ok);
  assert.ok(first.skipped || second.skipped);
});

test("recovery quarantines a stale provider-submission marker without resubmitting", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  let submissions = 0;
  const deps = dependencies(database, REAL_SETTINGS, async () => {
    submissions += 1;
    return {
      providerMessageId: "must-not-submit",
      error: null,
      failureDisposition: null,
    };
  });
  deps.now = () => now.value;
  const id = "e24fd1d2-3d21-487b-a641-cb0afb9d4405";
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    id,
    deps,
  );
  Object.assign(database.record!, {
    status: "sending",
    providerCredentialScope: getResendCredentialScope(REAL_SETTINGS.apiKey),
    claimedAt: new Date("2026-07-20T12:30:00.000Z"),
    claimToken: "stale-provider-claim",
  });
  now.value = new Date("2026-07-20T13:00:01.000Z");

  const result = await dispatchScheduledArbitraryEmailWithDependencies(id, deps);
  assert.equal(result.ok, false);
  assert.equal(submissions, 0);
  assert.equal(database.record?.status, "manual_review");
  assert.equal(database.record?.failureDisposition, "uncertain");
  assert.match(String(database.record?.error), /may have started/);
});

test("scheduled arbitrary email cancellation is conditional and idempotent", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const deps = dependencies(database, REAL_SETTINGS, async () => ({
    providerMessageId: "unused",
    error: null,
    failureDisposition: null,
  }));
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "37e7bd49-36e7-40cd-a018-cae15966f060",
    {
      ...deps,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    },
  );

  assert.equal(
    await cancelScheduledArbitraryEmailWithDatabase(
      "37e7bd49-36e7-40cd-a018-cae15966f060",
      database as never,
    ),
    true,
  );
  assert.equal(database.record?.status, "cancelled");
  assert.equal(
    await cancelScheduledArbitraryEmailWithDatabase(
      "37e7bd49-36e7-40cd-a018-cae15966f060",
      database as never,
    ),
    false,
  );
});

test("expired immutable provider requests require review instead of risking a duplicate", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  let submissions = 0;
  const deps = dependencies(database, REAL_SETTINGS, async () => {
    submissions += 1;
    return {
      providerMessageId: null,
      error: "temporary provider outage",
      failureDisposition: "retryable",
    };
  });
  deps.now = () => now.value;
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "2594c95f-a551-4739-8da4-d287aa001434",
    deps,
  );
  now.value = new Date("2026-07-20T13:00:01.000Z");
  const first = await dispatchScheduledArbitraryEmailWithDependencies(
    "2594c95f-a551-4739-8da4-d287aa001434",
    deps,
  );
  assert.equal(first.retryScheduled, true);
  assert.equal(submissions, 1);

  now.value = new Date("2026-07-21T13:01:00.000Z");
  const expired = await dispatchScheduledArbitraryEmailWithDependencies(
    "2594c95f-a551-4739-8da4-d287aa001434",
    deps,
  );
  assert.equal(expired.ok, false);
  assert.equal(submissions, 1);
  assert.equal(database.record?.status, "manual_review");
  assert.match(String(database.record?.error), /idempotency retention/);
});

test("recovery finalizes a webhook-bound provider acceptance without resubmitting", async () => {
  const database = new MemoryArbitraryEmailDatabase();
  const now = { value: new Date("2026-07-20T12:00:00.000Z") };
  let submissions = 0;
  const deps = dependencies(database, REAL_SETTINGS, async () => {
    submissions += 1;
    return {
      providerMessageId: "duplicate",
      error: null,
      failureDisposition: null,
    };
  });
  deps.now = () => now.value;
  await queueArbitraryEmailWithDependencies(
    INPUT,
    new Date("2026-07-20T13:00:00.000Z"),
    "f39c534d-21e7-459b-9187-c9b1cf10162e",
    deps,
  );
  Object.assign(database.record!, {
    status: "queued",
    providerMessageId: "webhook-bound",
    testSend: true,
    claimedAt: new Date("2026-07-20T12:30:00.000Z"),
    claimToken: "stale-claim",
  });
  now.value = new Date("2026-07-20T13:00:01.000Z");

  const result = await dispatchScheduledArbitraryEmailWithDependencies(
    "f39c534d-21e7-459b-9187-c9b1cf10162e",
    deps,
  );
  assert.equal(result.ok, true);
  assert.equal(submissions, 0);
  assert.equal(database.record?.status, "test");
  assert.equal(database.record?.claimToken, null);
});
