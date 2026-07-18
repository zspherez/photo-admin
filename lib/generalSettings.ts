import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  EMAIL_UTM_DEFAULTS,
  EMAIL_UTM_SETTING_KEYS,
  resolveEmailUtmSettings,
  type EmailUtmSettings,
} from "@/lib/emailUtm";

export const GENERAL_SETTING_FIELDS = [
  {
    key: "sender_name",
    label: "Your name",
    placeholder: "Jane Doe",
    description:
      "Substituted into {{sender_name}} in email templates (signature, etc.).",
  },
  {
    key: "sender_email",
    label: "Your email",
    placeholder: "you@example.com",
    description: "Substituted into {{sender_email}} in email templates.",
  },
  {
    key: "sender_phone",
    label: "Your phone",
    placeholder: "+1.555.555.5555",
    description: "Substituted into {{sender_phone}} in email templates.",
  },
  {
    key: "sender_city",
    label: "Your city",
    placeholder: "NYC",
    description:
      "Substituted into {{sender_city}} (used in the default template's pitch line).",
  },
  {
    key: "portfolio_url",
    label: "Portfolio URL",
    placeholder: "https://example.com",
    description: "Substituted into {{portfolio_url}} in email templates.",
  },
  {
    key: "default_rate",
    label: "Default rate",
    placeholder: "$400",
    description: "Used for {{rate}} when a contact has no customPrice.",
  },
  {
    key: "venue_blocklist",
    label: "Venue blocklist",
    placeholder: "venue one, venue two",
    description:
      "Comma-separated substrings (case-insensitive). EDMTrain shows whose venue matches are filtered out.",
  },
  {
    key: "test_override_email",
    label: "Test mode — redirect all sends to",
    placeholder: "you+test@example.com",
    description:
      "When set, every send goes here instead of the real contacts (subject prefixed with [TEST → original]). Leave blank to send to real contacts. Overrides SEND_TEST_OVERRIDE env.",
  },
  {
    key: "bcc_emails",
    label: "BCC me on every send",
    placeholder: "you@example.com",
    description:
      "Comma-separated. Added as BCC on every real send (skipped when test mode is on, to avoid CC-ing yourself on tests).",
  },
  {
    key: "utm_source",
    label: "Email UTM source",
    placeholder: EMAIL_UTM_DEFAULTS.utm_source,
    description:
      "Added as utm_source to web links in new outbound emails. Leave blank to omit it.",
    defaultValue: EMAIL_UTM_DEFAULTS.utm_source,
  },
  {
    key: "utm_medium",
    label: "Email UTM medium",
    placeholder: EMAIL_UTM_DEFAULTS.utm_medium,
    description:
      "Added as utm_medium to web links in new outbound emails. Leave blank to omit it.",
    defaultValue: EMAIL_UTM_DEFAULTS.utm_medium,
  },
  {
    key: "utm_campaign_original",
    label: "Original email UTM campaign",
    placeholder: EMAIL_UTM_DEFAULTS.utm_campaign_original,
    description:
      "Added as utm_campaign to original outreach links. Leave blank to omit it.",
    defaultValue: EMAIL_UTM_DEFAULTS.utm_campaign_original,
  },
  {
    key: "utm_campaign_follow_up",
    label: "Follow-up email UTM campaign",
    placeholder: EMAIL_UTM_DEFAULTS.utm_campaign_follow_up,
    description:
      "Added as utm_campaign to follow-up links. Leave blank to omit it.",
    defaultValue: EMAIL_UTM_DEFAULTS.utm_campaign_follow_up,
  },
] as const;

export type GeneralSettingKey = (typeof GENERAL_SETTING_FIELDS)[number]["key"];
export type GeneralSettingsValues = Record<GeneralSettingKey, string>;

export const GENERAL_SETTING_KEYS = GENERAL_SETTING_FIELDS.map(
  (field) => field.key,
);
export const GENERAL_DELIVERY_SETTING_KEYS = [
  "test_override_email",
  "bcc_emails",
] as const satisfies readonly GeneralSettingKey[];

const PRESERVE_EMPTY_SETTING_KEYS = new Set<GeneralSettingKey>(
  [...GENERAL_DELIVERY_SETTING_KEYS, ...EMAIL_UTM_SETTING_KEYS],
);

export interface GeneralDeliverySettingsSnapshot {
  testOverrideValue: string | null;
  bccEmailsValue: string | null;
}

export type GeneralSettingsTransactionRunner = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

const runDefaultTransaction: GeneralSettingsTransactionRunner = (work) =>
  db.$transaction(work);

export function generalSettingsValuesFromFormData(
  formData: Pick<FormData, "get">,
): GeneralSettingsValues {
  return Object.fromEntries(
    GENERAL_SETTING_KEYS.map((key) => {
      const entry = formData.get(key);
      return [key, typeof entry === "string" ? entry.trim() : ""];
    }),
  ) as GeneralSettingsValues;
}

export async function acquireGeneralSettingsReadLock(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`LOCK TABLE "Setting" IN SHARE MODE`);
}

export async function acquireGeneralSettingsWriteLock(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`LOCK TABLE "Setting" IN SHARE ROW EXCLUSIVE MODE`,
  );
}

export async function readGeneralDeliverySettingsInTransaction(
  tx: Prisma.TransactionClient,
): Promise<GeneralDeliverySettingsSnapshot> {
  await acquireGeneralSettingsReadLock(tx);
  const rows = await tx.setting.findMany({
    where: { key: { in: [...GENERAL_DELIVERY_SETTING_KEYS] } },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    testOverrideValue: values.get("test_override_email") ?? null,
    bccEmailsValue: values.get("bcc_emails") ?? null,
  };
}

export async function readGeneralDeliverySettingsSnapshot(
  runTransaction: GeneralSettingsTransactionRunner = runDefaultTransaction,
): Promise<GeneralDeliverySettingsSnapshot> {
  return runTransaction(readGeneralDeliverySettingsInTransaction);
}

export async function readEmailUtmSettingsInTransaction(
  tx: Prisma.TransactionClient,
): Promise<EmailUtmSettings> {
  await acquireGeneralSettingsReadLock(tx);
  const rows = await tx.setting.findMany({
    where: { key: { in: [...EMAIL_UTM_SETTING_KEYS] } },
    select: { key: true, value: true },
  });
  return resolveEmailUtmSettings(
    Object.fromEntries(rows.map((row) => [row.key, row.value])),
  );
}

export async function readEmailUtmSettingsSnapshot(
  runTransaction: GeneralSettingsTransactionRunner = runDefaultTransaction,
): Promise<EmailUtmSettings> {
  return runTransaction(readEmailUtmSettingsInTransaction);
}

export async function saveGeneralSettingsAtomically(
  values: GeneralSettingsValues,
  runTransaction: GeneralSettingsTransactionRunner = runDefaultTransaction,
): Promise<void> {
  await runTransaction(async (tx) => {
    await acquireGeneralSettingsWriteLock(tx);
    for (const key of GENERAL_SETTING_KEYS) {
      const value = values[key];
      if (value || PRESERVE_EMPTY_SETTING_KEYS.has(key)) {
        await tx.setting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      } else {
        await tx.setting.deleteMany({ where: { key } });
      }
    }
  });
}
