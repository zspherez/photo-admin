import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
const exporter = readFileSync(
  new URL("../../../lib/googleSheetContactExport.ts", import.meta.url),
  "utf8",
);

test("contact settings replaces inbound sync with database counts and snapshots", () => {
  assert.match(page, /Postgres is canonical/);
  assert.match(page, /state: "active"/);
  assert.match(page, /state: "quarantined"/);
  assert.match(page, /Recent exports/);
  assert.match(page, /contentSha256/);
  assert.match(page, /GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID/);
  assert.doesNotMatch(page, /syncContactsFromSheet|listTabs|Sync from Sheet/);
});

test("contact snapshot action is admin-only and explicitly confirmed", () => {
  assert.match(
    actions,
    /requireServerActionAuth\("\/settings\/contacts"\)/,
  );
  assert.match(actions, /confirmation !== "EXPORT"/);
  assert.match(actions, /requestedByRole: "admin"/);
  assert.match(actions, /params\.set\("retryKey", idempotencyKey\)/);
  assert.match(actions, /exportGoogleContactSnapshot/);
});

test("export is repeatable-read, leased, idempotent, and finalized after verification", () => {
  assert.match(
    exporter,
    /Prisma\.TransactionIsolationLevel\.RepeatableRead/,
  );
  assert.match(exporter, /makeIntegrationSyncLeaseKey/);
  assert.match(exporter, /idempotencyKey/);
  assert.match(exporter, /verifySnapshotWrite/);
  assert.ok(
    exporter.indexOf("verifySnapshotWrite") <
      exporter.lastIndexOf('status: "complete"'),
  );
  assert.doesNotMatch(exporter, /syncContactsFromSheet/);
});
