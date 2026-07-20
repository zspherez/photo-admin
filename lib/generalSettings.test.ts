import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  GENERAL_SETTING_KEYS,
  generalSettingsValuesFromFormData,
  readEmailUtmSettingsSnapshot,
  readGeneralDeliverySettingsSnapshot,
  saveGeneralSettingsAtomically,
  type GeneralSettingsTransactionRunner,
  type GeneralSettingsValues,
} from "./generalSettings";

class SerialPolicyLock {
  private tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

class MemorySettingStore {
  private committed: Map<string, string>;
  private readonly lock = new SerialPolicyLock();
  mutationCount = 0;
  lockModes: string[] = [];
  failMutationAt: number | null = null;
  onMutation: ((key: string) => Promise<void>) | null = null;
  onRead: (() => Promise<void>) | null = null;

  constructor(initial: Record<string, string>) {
    this.committed = new Map(Object.entries(initial));
  }

  values(): Record<string, string> {
    return Object.fromEntries(this.committed);
  }

  readonly runTransaction: GeneralSettingsTransactionRunner = async <T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> => {
    let release = () => {};
    let locked = false;
    let write = false;
    let draft: Map<string, string> | null = null;
    const ensureLocked = () => {
      if (!locked) {
        throw new Error("Setting transaction did not acquire its policy lock");
      }
    };
    const mutate = async (key: string, value: string | null) => {
      ensureLocked();
      if (!write || !draft) throw new Error("Setting mutation lacks write lock");
      this.mutationCount += 1;
      if (this.failMutationAt === this.mutationCount) {
        throw new Error("injected setting write failure");
      }
      if (value === null) draft.delete(key);
      else draft.set(key, value);
      await this.onMutation?.(key);
    };
    const tx = {
      $executeRaw: async (query: { sql?: string }) => {
        const sql = query.sql ?? "";
        release = await this.lock.acquire();
        locked = true;
        write = sql.includes("SHARE ROW EXCLUSIVE");
        draft = write ? new Map(this.committed) : null;
        this.lockModes.push(write ? "write" : "read");
        return 0;
      },
      setting: {
        upsert: async (args: {
          where: { key: string };
          create: { key: string; value: string };
          update: { value: string };
        }) => {
          await mutate(args.where.key, args.update.value);
          return args.create;
        },
        deleteMany: async (args: { where: { key: string } }) => {
          await mutate(args.where.key, null);
          return { count: 1 };
        },
        findMany: async (args: {
          where: { key: { in: string[] } };
        }) => {
          ensureLocked();
          const rows = args.where.key.in.flatMap((key) => {
            const value = this.committed.get(key);
            return value === undefined ? [] : [{ key, value }];
          });
          await this.onRead?.();
          return rows;
        },
      },
    } as unknown as Prisma.TransactionClient;

    try {
      const result = await work(tx);
      if (write && draft) this.committed = draft;
      return result;
    } finally {
      if (locked) release();
    }
  };
}

function settingsValues(
  overrides: Partial<GeneralSettingsValues> = {},
): GeneralSettingsValues {
  return Object.fromEntries(
    GENERAL_SETTING_KEYS.map((key) => [key, overrides[key] ?? ""]),
  ) as GeneralSettingsValues;
}

test("general settings normalize form values and preserve explicit delivery blanks", async () => {
  const formData = new FormData();
  formData.set("sender_name", "  New Sender  ");
  formData.set("venue_blocklist", "Surf Lodge");
  formData.set("test_override_email", "   ");
  formData.set("bcc_emails", "   ");
  const values = generalSettingsValuesFromFormData(formData);
  assert.equal(values.sender_name, "New Sender");
  assert.equal(Object.hasOwn(values, "venue_blocklist"), false);
  assert.equal(
    (GENERAL_SETTING_KEYS as readonly string[]).includes("venue_blocklist"),
    false,
  );

  const store = new MemorySettingStore({
    sender_name: "Old Sender",
    sender_email: "old@example.com",
    default_rate: "$650",
    venue_blocklist: "Surf Lodge",
    test_override_email: "test@example.com",
    bcc_emails: "audit@example.com",
    unrelated: "keep",
  });

  await saveGeneralSettingsAtomically(values, store.runTransaction);

  assert.deepEqual(store.values(), {
    sender_name: "New Sender",
    default_rate: "$650",
    venue_blocklist: "Surf Lodge",
    test_override_email: "",
    bcc_emails: "",
    utm_source: "",
    utm_medium: "",
    utm_campaign_original: "",
    utm_campaign_follow_up: "",
    unrelated: "keep",
  });
  assert.deepEqual(store.lockModes, ["write"]);
  assert.equal(
    (GENERAL_SETTING_KEYS as readonly string[]).includes("default_rate"),
    false,
  );
});

test("UTM settings default when missing and preserve intentional blanks", async () => {
  const store = new MemorySettingStore({});
  assert.deepEqual(await readEmailUtmSettingsSnapshot(store.runTransaction), {
    utm_source: "photo_admin",
    utm_medium: "email",
    utm_campaign_original: "outreach",
    utm_campaign_follow_up: "follow_up",
  });

  await saveGeneralSettingsAtomically(
    settingsValues({
      utm_source: "",
      utm_medium: "",
      utm_campaign_original: "",
      utm_campaign_follow_up: "",
    }),
    store.runTransaction,
  );
  assert.deepEqual(await readEmailUtmSettingsSnapshot(store.runTransaction), {
    utm_source: "",
    utm_medium: "",
    utm_campaign_original: "",
    utm_campaign_follow_up: "",
  });
});

test("general settings roll back every key when any write fails", async () => {
  const initial = {
    sender_name: "Old Sender",
    sender_email: "old@example.com",
    test_override_email: "old-test@example.com",
    bcc_emails: "old-bcc@example.com",
  };
  const store = new MemorySettingStore(initial);
  store.failMutationAt = 4;

  await assert.rejects(
    saveGeneralSettingsAtomically(
      settingsValues({
        sender_name: "New Sender",
        sender_email: "new@example.com",
        test_override_email: "new-test@example.com",
        bcc_emails: "new-bcc@example.com",
      }),
      store.runTransaction,
    ),
    /injected setting write failure/,
  );
  assert.deepEqual(store.values(), initial);
});

test("delivery policy readers observe the complete old or new settings snapshot", async () => {
  const oldValues = {
    test_override_email: "old-test@example.com",
    bcc_emails: "old-bcc@example.com",
  };
  const store = new MemorySettingStore(oldValues);
  let writerPaused!: () => void;
  const writerIsPaused = new Promise<void>((resolve) => {
    writerPaused = resolve;
  });
  let continueWriter!: () => void;
  const writerGate = new Promise<void>((resolve) => {
    continueWriter = resolve;
  });
  store.onMutation = async (key) => {
    if (key === "test_override_email") {
      writerPaused();
      await writerGate;
    }
  };

  const save = saveGeneralSettingsAtomically(
    settingsValues({
      test_override_email: "new-test@example.com",
      bcc_emails: "new-bcc@example.com",
    }),
    store.runTransaction,
  );
  await writerIsPaused;
  let readFinished = false;
  const read = readGeneralDeliverySettingsSnapshot(store.runTransaction).then(
    (snapshot) => {
      readFinished = true;
      return snapshot;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readFinished, false);
  continueWriter();
  await save;
  assert.deepEqual(await read, {
    testOverrideValue: "new-test@example.com",
    bccEmailsValue: "new-bcc@example.com",
  });

  const readerFirstStore = new MemorySettingStore(oldValues);
  let readerPaused!: () => void;
  const readerIsPaused = new Promise<void>((resolve) => {
    readerPaused = resolve;
  });
  let continueReader!: () => void;
  const readerGate = new Promise<void>((resolve) => {
    continueReader = resolve;
  });
  readerFirstStore.onRead = async () => {
    readerPaused();
    await readerGate;
  };
  const oldRead = readGeneralDeliverySettingsSnapshot(
    readerFirstStore.runTransaction,
  );
  await readerIsPaused;
  const laterSave = saveGeneralSettingsAtomically(
    settingsValues({
      test_override_email: "new-test@example.com",
      bcc_emails: "new-bcc@example.com",
    }),
    readerFirstStore.runTransaction,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(readerFirstStore.values(), oldValues);
  continueReader();
  assert.deepEqual(await oldRead, {
    testOverrideValue: "old-test@example.com",
    bccEmailsValue: "old-bcc@example.com",
  });
  await laterSave;
  assert.deepEqual(readerFirstStore.values(), {
    test_override_email: "new-test@example.com",
    bcc_emails: "new-bcc@example.com",
    utm_source: "",
    utm_medium: "",
    utm_campaign_original: "",
    utm_campaign_follow_up: "",
  });
});
