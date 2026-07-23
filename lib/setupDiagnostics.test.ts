import assert from "node:assert/strict";
import test from "node:test";
import { runSetupDiagnostics } from "./setupDiagnostics";

const VALID_CORE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: "postgresql://localhost:6543/postgres",
  DIRECT_URL: "postgresql://localhost:5432/postgres",
  APP_BASE_URL: "http://127.0.0.1:3000",
  ADMIN_PASSWORD: "test-admin-password",
  ADMIN_SESSION_SECRET: "test-session-secret",
};

test("passes with fully valid required configuration and never fails the check", () => {
  const report = runSetupDiagnostics(VALID_CORE_ENV);
  assert.equal(report.ok, true);
  assert.ok(report.required.every((item) => item.status === "ok"));
});

test("reports every required item missing on a fully empty environment", () => {
  const report = runSetupDiagnostics({});
  assert.equal(report.ok, false);
  const statuses = Object.fromEntries(
    report.required.map((item) => [item.key, item.status])
  );
  assert.equal(statuses.DATABASE_URL, "missing");
  assert.equal(statuses.DIRECT_URL, "missing");
  assert.equal(statuses.APP_BASE_URL, "missing");
  assert.equal(statuses.AUTH, "invalid");
});

test("accepts local-only open mode as valid authentication", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    ADMIN_PASSWORD: undefined,
    ADMIN_SESSION_SECRET: undefined,
    ALLOW_INSECURE_OPEN_MODE: "true",
  });
  const auth = report.required.find((item) => item.key === "AUTH");
  assert.equal(auth?.status, "ok");
  assert.equal(auth?.detail, "mode=open");
  assert.equal(report.ok, true);
});

test("rejects a non-Postgres DATABASE_URL", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    DATABASE_URL: "mysql://localhost:3306/db",
  });
  const item = report.required.find((entry) => entry.key === "DATABASE_URL");
  assert.equal(item?.status, "invalid");
  assert.equal(report.ok, false);
});

test("rejects a non-http(s) APP_BASE_URL", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    APP_BASE_URL: "ftp://example.com",
  });
  const item = report.required.find((entry) => entry.key === "APP_BASE_URL");
  assert.equal(item?.status, "invalid");
  assert.equal(report.ok, false);
});

test("fork-identity overrides are only checked when explicitly set", () => {
  const withoutOverride = runSetupDiagnostics(VALID_CORE_ENV);
  assert.ok(
    !withoutOverride.required.some((item) => item.key === "REPOSITORY_SLUG")
  );
  assert.equal(withoutOverride.ok, true);
});

test("fails closed (required, not optional) when REPOSITORY_SLUG is set but malformed", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    REPOSITORY_SLUG: "not a slug",
  });
  const item = report.required.find((entry) => entry.key === "REPOSITORY_SLUG");
  assert.equal(item?.status, "invalid");
  assert.equal(report.ok, false);
});

test("accepts a valid REPOSITORY_SLUG override", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    REPOSITORY_SLUG: "my-org/my-fork",
  });
  const item = report.required.find((entry) => entry.key === "REPOSITORY_SLUG");
  assert.equal(item?.status, "ok");
  assert.equal(report.ok, true);
});

test("fails closed when CONTACT_RESEARCH_WORKFLOW_REF is set but malformed", () => {
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    CONTACT_RESEARCH_WORKFLOW_REF: "totally-invalid",
  });
  const item = report.required.find(
    (entry) => entry.key === "CONTACT_RESEARCH_WORKFLOW_REF"
  );
  assert.equal(item?.status, "invalid");
  assert.equal(report.ok, false);
});

test("optional integrations are reported but never affect the overall ok status", () => {
  const report = runSetupDiagnostics(VALID_CORE_ENV);
  assert.equal(report.ok, true);
  assert.ok(report.optional.length > 0);
  assert.ok(report.optional.every((group) => group.configured === false));

  const withResend = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    RESEND_API_KEY: "re_test_key",
  });
  const resendGroup = withResend.optional.find(
    (group) => group.group === "resend"
  );
  assert.equal(resendGroup?.configured, true);
  assert.equal(withResend.ok, true);
});

test("never includes a raw secret value anywhere in the report", () => {
  const secretValue = "super-secret-value-should-not-leak";
  const report = runSetupDiagnostics({
    ...VALID_CORE_ENV,
    RESEND_API_KEY: secretValue,
    CRON_SECRET: secretValue,
    ADMIN_PASSWORD: secretValue,
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(secretValue));
});
