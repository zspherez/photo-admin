import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertSafeDatabaseTestWrite,
  databaseTargetFingerprint,
  DESTRUCTIVE_TEST_CONFIRMATION,
  SAFE_TEST_DATABASE_URL,
  sanitizedTestEnvironment,
} from "./databaseWriteSafety";

test("write-capable tests accept only local non-production database targets", () => {
  assert.doesNotThrow(() =>
    assertSafeDatabaseTestWrite([SAFE_TEST_DATABASE_URL], {
      NODE_ENV: "test",
      VERCEL_ENV: "development",
    })
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite(
        ["postgresql://tester@production-db.example.com/photo_admin"],
        { NODE_ENV: "test" }
      ),
    /Refusing a write-capable test/
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite(
        ["postgresql://tester@127.0.0.1:5432/photo_admin_production"],
        { NODE_ENV: "test" }
      ),
    /Refusing a write-capable test/
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([SAFE_TEST_DATABASE_URL], {
        VERCEL_ENV: "production",
      }),
    /Refusing a write-capable test/
  );
});

test("unknown remote targets remain rejected even with confirmation", () => {
  const remote = "postgresql://tester@db-42.internal/app_test";
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([remote], {
        DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
          DESTRUCTIVE_TEST_CONFIRMATION,
      }),
    /unknown remote database target/
  );
});

test("remote disposable targets require confirmation and a positive allowlist", () => {
  const remote = "postgresql://tester@preview-db.internal/photo_admin_test";
  const allowlist = {
    TEST_DATABASE_ALLOWED_HOSTS: "preview-db.internal",
    TEST_DATABASE_ALLOWED_DATABASES: "photo_admin_test",
  };
  assert.throws(
    () => assertSafeDatabaseTestWrite([remote], allowlist),
    /unknown remote database target/
  );
  assert.doesNotThrow(() =>
    assertSafeDatabaseTestWrite([remote], {
      ...allowlist,
      DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
        DESTRUCTIVE_TEST_CONFIRMATION,
    })
  );
});

test("remote fingerprint authorization is exact and credential-independent", () => {
  const remote =
    "postgresql://tester:secret@ephemeral.internal:6543/photo_admin_test";
  const fingerprint = databaseTargetFingerprint(remote);
  assert.doesNotThrow(() =>
    assertSafeDatabaseTestWrite([remote], {
      TEST_DATABASE_ALLOWED_SHA256: fingerprint,
      DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
        DESTRUCTIVE_TEST_CONFIRMATION,
    })
  );
  assert.equal(
    fingerprint,
    databaseTargetFingerprint(
      "postgresql://different:credentials@ephemeral.internal:6543/photo_admin_test"
    )
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([remote], {
        TEST_DATABASE_ALLOWED_SHA256: "0".repeat(64),
        DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
          DESTRUCTIVE_TEST_CONFIRMATION,
      }),
    /unknown remote database target/
  );
});

test("production identities and environments cannot be overridden", () => {
  const allowlist = {
    TEST_DATABASE_ALLOWED_HOSTS: "production-db.example.com",
    TEST_DATABASE_ALLOWED_DATABASES: "photo_admin",
    DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
      DESTRUCTIVE_TEST_CONFIRMATION,
  };
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite(
        ["postgresql://tester@production-db.example.com/photo_admin"],
        allowlist
      ),
    /production database target/
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([SAFE_TEST_DATABASE_URL], {
        VERCEL_ENV: "Production",
        DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
          DESTRUCTIVE_TEST_CONFIRMATION,
      }),
    /production database target/
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([SAFE_TEST_DATABASE_URL], {
        VERCEL: "1",
      }),
    /production database target/
  );
});

test("the npm test environment replaces inherited database and auth secrets", () => {
  const sanitized = sanitizedTestEnvironment({
    NODE_ENV: "production",
    VERCEL_ENV: "production",
    DATABASE_URL: "postgresql://secret@production.example.com/app",
    DIRECT_URL: "postgresql://secret@production.example.com/app",
    CONTACT_RESEARCH_AGENT_TOKEN: "research-secret",
    CONTACT_AUDIT_AGENT_TOKEN: "audit-secret",
    CRON_SECRET: "cron-secret",
  });

  assert.equal(sanitized.NODE_ENV, "test");
  assert.equal(sanitized.VERCEL_ENV, "development");
  assert.equal(sanitized.DATABASE_URL, SAFE_TEST_DATABASE_URL);
  assert.equal(sanitized.DIRECT_URL, SAFE_TEST_DATABASE_URL);
  assert.equal(sanitized.CONTACT_RESEARCH_AGENT_TOKEN, "");
  assert.equal(sanitized.CONTACT_AUDIT_AGENT_TOKEN, "");
  assert.equal(sanitized.CRON_SECRET, "");
  assert.equal(sanitized.TEST_DATABASE_ALLOWED_HOSTS, "");
  assert.equal(sanitized.TEST_DATABASE_ALLOWED_DATABASES, "");
  assert.equal(sanitized.TEST_DATABASE_ALLOWED_SHA256, "");
  assert.equal(sanitized.DOTENV_CONFIG_OVERRIDE, "false");
});

test("npm test always preloads the sanitized environment", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts: { test: string } };
  const bootstrap = readFileSync(
    new URL("../scripts/test-environment.mjs", import.meta.url),
    "utf8"
  );

  assert.match(packageJson.scripts.test, /--import \.\/scripts\/test-environment\.mjs/);
  assert.match(bootstrap, /sanitizedTestEnvironment/);
  assert.doesNotMatch(bootstrap, /console\.(?:log|error)/);
});
