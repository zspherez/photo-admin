import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import {
  googleContactExportSpreadsheetId,
  hasGoogleContactExportConfiguration,
} from "@/lib/googleSheetContactExport";
import { firstSearchParam, type SearchParamValue } from "@/lib/searchParams";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { SyncBanner } from "@/components/sync-banner";
import { SyncForm } from "@/components/sync-form";
import { exportContactSnapshotAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact snapshots" };

function exportStatusTone(status: string): BadgeTone {
  if (status === "complete") return "success";
  if (status === "failed") return "danger";
  if (status === "writing") return "info";
  return "warning";
}

export default async function ContactsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    export?: SearchParamValue;
    snapshot?: SearchParamValue;
    count?: SearchParamValue;
    detail?: SearchParamValue;
    retryKey?: SearchParamValue;
  }>;
}) {
  const rawSearchParams = await searchParams;
  const result = firstSearchParam(rawSearchParams.export);
  const snapshotId = firstSearchParam(rawSearchParams.snapshot);
  const exportedCount = firstSearchParam(rawSearchParams.count);
  const detail = firstSearchParam(rawSearchParams.detail);
  const requestedRetryKey = firstSearchParam(rawSearchParams.retryKey);
  const retrying = Boolean(
    requestedRetryKey &&
      /^[A-Za-z0-9._:-]{16,128}$/.test(requestedRetryKey),
  );
  const idempotencyKey =
    retrying && requestedRetryKey ? requestedRetryKey : randomUUID();
  const exportConfigured = hasGoogleContactExportConfiguration();
  let destinationId: string | null = null;
  try {
    destinationId = googleContactExportSpreadsheetId();
  } catch {
    destinationId = null;
  }

  const [totalContacts, activeContacts, quarantinedContacts, recentExports] =
    await Promise.all([
      db.contact.count({
        where: { state: { in: ["active", "quarantined"] } },
      }),
      db.contact.count({ where: { state: "active" } }),
      db.contact.count({ where: { state: "quarantined" } }),
      db.contactExportSnapshot.findMany({
        take: 10,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          idempotencyKey: true,
          status: true,
          contactCount: true,
          contentSha256: true,
          sheetTabName: true,
          sheetUrl: true,
          error: true,
          startedAt: true,
          completedAt: true,
        },
      }),
    ]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href="/settings"
        className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Settings
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <Link
          href="/contacts"
          className="text-sm text-blue-700 hover:underline dark:text-blue-300"
        >
          View all contacts
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Postgres is canonical. Google Sheets exports are one-way, immutable
        point-in-time snapshots and are never imported.
      </p>

      {result === "ok" && (
        <SyncBanner
          tone="success"
          title="Snapshot export complete."
          detail={`${exportedCount ?? "?"} contacts · ${snapshotId ?? "unknown snapshot"}`}
        />
      )}
      {result === "error" && (
        <SyncBanner
          tone="error"
          title="Snapshot export failed."
          detail={detail ?? "Retry with the same idempotency key."}
        />
      )}

      {!exportConfigured && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Export is disabled until{" "}
          <code>GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID</code> and Google service
          account credentials are configured.
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          ["All contacts", totalContacts],
          ["Active", activeContacts],
          ["Quarantined", quarantinedContacts],
        ].map(([label, count]) => (
          <Card key={String(label)}>
            <CardBody>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {label}
              </p>
              <p className="mt-2 text-2xl font-semibold">
                {Number(count).toLocaleString()}
              </p>
            </CardBody>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardBody>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Export snapshot
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Creates a new tab containing active and quarantined contacts,
            sorted deterministically. Existing tabs are never selected as a
            contact source.
          </p>
          {destinationId && (
            <p className="mt-2 break-all text-xs text-zinc-500">
              Destination spreadsheet: <code>{destinationId}</code>
            </p>
          )}
          <SyncForm
            action={exportContactSnapshotAction}
            label={
              retrying ? "Retry snapshot export" : "Export new snapshot"
            }
            pendingLabel={retrying ? "Retrying…" : "Exporting…"}
            hiddenFields={{ idempotencyKey }}
            disabled={!exportConfigured}
            className="mt-4 space-y-3"
          >
            <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                name="confirmation"
                value="EXPORT"
                required
                className="mt-0.5"
              />
              <span>
                I understand this writes a new immutable Google Sheet tab and
                does not change Postgres contacts.
              </span>
            </label>
          </SyncForm>
        </CardBody>
      </Card>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Recent exports
        </h2>
        <Card className="mt-3">
          {recentExports.length === 0 ? (
            <CardBody>
              <p className="text-sm text-zinc-500">
                No contact snapshots have been exported.
              </p>
            </CardBody>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {recentExports.map((snapshot) => (
                <li key={snapshot.id} className="px-4 py-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{snapshot.sheetTabName}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {snapshot.contactCount.toLocaleString()} contacts ·{" "}
                        {(
                          snapshot.completedAt ?? snapshot.startedAt
                        ).toLocaleString()}
                      </p>
                    </div>
                    <Badge tone={exportStatusTone(snapshot.status)} size="xs">
                      {snapshot.status}
                    </Badge>
                  </div>
                  <p className="mt-2 break-all font-mono text-[11px] text-zinc-500">
                    SHA-256 {snapshot.contentSha256}
                  </p>
                  {snapshot.error && (
                    <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                      {snapshot.error}
                    </p>
                  )}
                  {snapshot.sheetUrl && (
                    <a
                      href={snapshot.sheetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs text-blue-700 hover:underline dark:text-blue-300"
                    >
                      Open snapshot ↗
                    </a>
                  )}
                  {(snapshot.status === "failed" ||
                    snapshot.status === "writing") && (
                    <SyncForm
                      action={exportContactSnapshotAction}
                      label={
                        snapshot.status === "writing"
                          ? "Resume export"
                          : "Retry export"
                      }
                      pendingLabel="Retrying…"
                      hiddenFields={{
                        idempotencyKey: snapshot.idempotencyKey,
                        confirmation: "EXPORT",
                      }}
                      className="mt-3"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </main>
  );
}
