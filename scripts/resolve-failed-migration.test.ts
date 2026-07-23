import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("./resolve-failed-migration.ts", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/release-production.yml", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260723030000_monthly_contact_audit_requests/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("monthly request migration no longer mutates terminal legacy rows", () => {
  assert.doesNotMatch(migration, /UPDATE "ContactAuditRequest"/);
  assert.match(migration, /ADD COLUMN "source"/);
  assert.match(migration, /ContactAuditRequest_one_running_key/);
});

test("release resolves only an exact recorded failed migration before verification", () => {
  assert.match(script, /DATABASE_URL and DIRECT_URL are required/);
  assert.match(
    script,
    /INSERT INTO "Setting"[\s\S]*SELECT "value"[\s\S]*do not target the same database/,
  );
  assert.match(
    script,
    /WHERE "finished_at" IS NULL[\s\S]*"rolled_back_at" IS NULL/,
  );
  assert.match(script, /rows\.length !== 1/);
  assert.match(
    script,
    /failed\.migrationName !== migrationName[\s\S]*failed\.checksum\.toLowerCase\(\) !== expectedFailedChecksum/,
  );
  assert.match(
    script,
    /"--no-install"[\s\S]*"prisma"[\s\S]*"migrate"[\s\S]*"resolve"[\s\S]*"--rolled-back"[\s\S]*migrationName/,
  );
  assert.match(
    workflow,
    /Resolve recorded monthly audit migration failure[\s\S]*db:resolve-failed-migration --[\s\S]*20260723030000_monthly_contact_audit_requests[\s\S]*82b672fcedb0916eaa6c5c0951477479d13bcd681f5914ba09513f936e329f1e/,
  );
  assert.ok(
    workflow.indexOf("Resolve recorded monthly audit migration failure") <
      workflow.indexOf(
        "Bind requested SHA to production migration history and verify database connections",
      ),
  );
});
