import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertSafeDatabaseTestWrite,
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

test("non-local test writes require the exact one-off confirmation", () => {
  const remote = "postgresql://tester@preview-db.example.com/photo_admin_test";
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([remote], {
        DESTRUCTIVE_TEST_DATABASE_CONFIRMATION: "CONFIRM",
      }),
    /Refusing a write-capable test/
  );
  assert.doesNotThrow(() =>
    assertSafeDatabaseTestWrite([remote], {
      DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
        DESTRUCTIVE_TEST_CONFIRMATION,
    })
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite(
        ["postgresql://tester@production-db.example.com/photo_admin"],
        {
          DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
            DESTRUCTIVE_TEST_CONFIRMATION,
        }
      ),
    /production database target/
  );
  assert.throws(
    () =>
      assertSafeDatabaseTestWrite([remote], {
        VERCEL_ENV: "production",
        DESTRUCTIVE_TEST_DATABASE_CONFIRMATION:
          DESTRUCTIVE_TEST_CONFIRMATION,
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
