import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectedEmailRange } from "./email-bulk-selection";

test("shift selection returns an inclusive visible range in either direction", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(selectedEmailRange(ids, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(selectedEmailRange(ids, "d", "b"), ["b", "c", "d"]);
});

test("bulk email action confirms soft deletion and exposes restore", () => {
  const source = readFileSync(
    new URL("./email-bulk-selection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /window\.confirm\(confirmation\)/);
  assert.match(source, /delivery history remains intact/);
  assert.match(source, /scheduled sends are not cancelled/);
  assert.match(source, /Delete selected/);
  assert.match(source, /Restore selected/);
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260729110000_arbitrary_email_dismissal/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /ADD COLUMN "dismissedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ArbitraryEmail_dismissedAt_createdAt_idx/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});
