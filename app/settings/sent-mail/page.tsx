import type { Metadata } from "next";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { requireServerActionAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { acquireGeneralSettingsWriteLock } from "@/lib/generalSettings";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import {
  getSentMailImapConfiguration,
  SENT_MAIL_COPY_ENABLED_KEY,
  SENT_MAIL_COPY_MAILBOX_KEY,
  sentMailCopyEnabled,
  validateSentMailboxName,
} from "@/lib/sentMailConfig";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sent mailbox copy" };

async function saveSentMailSettings(formData: FormData) {
  "use server";
  await requireServerActionAuth("/settings/sent-mail");
  const enabled = formData.get("enabled") === "true";
  const mailboxEntry = formData.get("mailbox");
  const mailbox = typeof mailboxEntry === "string" ? mailboxEntry.trim() : "";
  const mailboxError = validateSentMailboxName(mailbox);
  const configuration = getSentMailImapConfiguration(mailbox);
  const error = mailboxError ?? (enabled && !configuration.ok
    ? configuration.error
    : null);
  if (error) {
    redirect(`/settings/sent-mail?error=${encodeURIComponent(error)}`);
  }

  await db.$transaction(async (tx) => {
    await acquireGeneralSettingsWriteLock(tx);
    await tx.setting.upsert({
      where: { key: SENT_MAIL_COPY_ENABLED_KEY },
      create: {
        key: SENT_MAIL_COPY_ENABLED_KEY,
        value: enabled ? "true" : "false",
      },
      update: { value: enabled ? "true" : "false" },
    });
    await tx.setting.upsert({
      where: { key: SENT_MAIL_COPY_MAILBOX_KEY },
      create: { key: SENT_MAIL_COPY_MAILBOX_KEY, value: mailbox },
      update: { value: mailbox },
    });
  });
  revalidatePath("/settings/sent-mail");
  revalidatePath("/settings");
  redirect("/settings/sent-mail?saved=1");
}

async function retryFailedSentMailCopies() {
  "use server";
  await requireServerActionAuth("/settings/sent-mail");
  await db.sentMailCopy.updateMany({
    where: { status: "manual_review" },
    data: {
      status: "retry_scheduled",
      attemptCount: 0,
      nextAttemptAt: new Date(),
      claimedAt: null,
      claimToken: null,
      error: null,
    },
  });
  revalidatePath("/settings/sent-mail");
  redirect("/settings/sent-mail?retried=1");
}

export default async function SentMailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: SearchParamValue;
    retried?: SearchParamValue;
    error?: SearchParamValue;
  }>;
}) {
  const query = await searchParams;
  const saved = firstSearchParam(query.saved);
  const retried = firstSearchParam(query.retried);
  const error = firstSearchParam(query.error);
  const [settings, statusCounts, latestFailure] = await Promise.all([
    db.setting.findMany({
      where: {
        key: {
          in: [SENT_MAIL_COPY_ENABLED_KEY, SENT_MAIL_COPY_MAILBOX_KEY],
        },
      },
    }),
    db.sentMailCopy.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.sentMailCopy.findFirst({
      where: { status: { in: ["retry_scheduled", "manual_review"] } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { error: true, updatedAt: true },
    }),
  ]);
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));
  const enabled = sentMailCopyEnabled(values.get(SENT_MAIL_COPY_ENABLED_KEY));
  const mailbox = values.get(SENT_MAIL_COPY_MAILBOX_KEY) ?? "";
  const configuration = getSentMailImapConfiguration(mailbox);
  const counts = new Map(
    statusCounts.map((row) => [row.status, row._count._all]),
  );

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link
        href="/settings"
        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Sent mailbox copy
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Append successful real Resend submissions to an actual IMAP Sent
        mailbox. This is separate from BCC.
      </p>

      {(saved || retried) && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          {retried ? "Failed copies queued for retry." : "Saved."}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      <Card className="mt-6">
        <CardBody>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              <span className="text-zinc-500">Configuration:</span>{" "}
              {configuration.ok
                ? `Ready (${configuration.config.provider})`
                : configuration.error}
            </p>
            <p>
              <span className="text-zinc-500">Copied:</span>{" "}
              {(counts.get("copied") ?? 0).toLocaleString()}
            </p>
            <p>
              <span className="text-zinc-500">Pending/retrying:</span>{" "}
              {(
                (counts.get("pending") ?? 0) +
                (counts.get("copying") ?? 0) +
                (counts.get("retry_scheduled") ?? 0)
              ).toLocaleString()}
            </p>
            <p>
              <span className="text-zinc-500">Manual review:</span>{" "}
              {(counts.get("manual_review") ?? 0).toLocaleString()}
            </p>
          </div>
          {latestFailure?.error && (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              Latest issue ({latestFailure.updatedAt.toLocaleString()}):{" "}
              {latestFailure.error}
            </p>
          )}
          {(counts.get("manual_review") ?? 0) > 0 && (
            <form action={retryFailedSentMailCopies} className="mt-4">
              <Button type="submit" variant="secondary">
                Retry failed copies
              </Button>
            </form>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <form action={saveSentMailSettings} className="space-y-5">
            <label className="flex items-start gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
              <input
                type="checkbox"
                name="enabled"
                value="true"
                defaultChecked={enabled}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">
                  Copy new successful real sends
                </span>
                <span className="mt-1 block text-xs text-zinc-500">
                  Test-mode messages are never copied. Existing queued copies
                  continue safely if this is later disabled.
                </span>
              </span>
            </label>
            <Field
              name="mailbox"
              label="Sent mailbox override"
              placeholder="[Gmail]/Sent Mail or Sent Messages"
              description="Leave blank to discover the IMAP mailbox advertised with the standard \\Sent attribute."
              defaultValue={mailbox}
            />
            <p className="text-xs text-zinc-500">
              IMAP host, port, TLS, username, and app password are server-only
              environment variables. See{" "}
              <Link
                href="https://github.com/zspherez/photo-admin/blob/main/docs/sent-mail.md"
                className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                the Sent mailbox setup documentation
              </Link>
              .
            </p>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
