import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260804162000_outreach_recipient_delivery_mode/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("recipient delivery migration preserves existing rows as separate threads", () => {
  assert.match(
    migration,
    /"recipientDeliveryMode" TEXT NOT NULL DEFAULT 'individual_threads'/,
  );
  assert.match(migration, /"primaryRecipientEmail" TEXT/);
  assert.match(migration, /Outreach_recipient_delivery_mode_check/);
  assert.match(
    migration,
    /'cc_thread'[\s\S]*"primaryRecipientEmail" = ANY\("recipientEmails"\)/,
  );
});
