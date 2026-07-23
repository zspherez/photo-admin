import assert from "node:assert/strict";
import test from "node:test";
import { runDeploymentReadiness } from "./deploymentReadiness";

const VALID_CORE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: "postgresql://localhost:6543/postgres",
  DIRECT_URL: "postgresql://localhost:5432/postgres",
  APP_BASE_URL: "http://127.0.0.1:3000",
  ADMIN_PASSWORD: "test-admin-password",
  ADMIN_SESSION_SECRET: "test-session-secret",
};

test("basic profile passes with just valid core configuration", () => {
  const report = runDeploymentReadiness("basic", VALID_CORE_ENV);
  assert.equal(report.profile, "basic");
  assert.equal(report.ok, true);
  assert.equal(report.profileRequired.length, 0);
});

test("basic profile never requires CRON_SECRET but warns when it is blank", () => {
  const report = runDeploymentReadiness("basic", VALID_CORE_ENV);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((warning) => warning.includes("CRON_SECRET")));
});

test("basic profile stops warning about CRON_SECRET once it is set", () => {
  const report = runDeploymentReadiness("basic", {
    ...VALID_CORE_ENV,
    CRON_SECRET: "a-header-safe-secret",
  });
  assert.ok(!report.warnings.some((warning) => warning.includes("CRON_SECRET is not set")));
});

test("basic profile always documents Vercel settings it cannot verify", () => {
  const report = runDeploymentReadiness("basic", VALID_CORE_ENV);
  assert.ok(
    report.warnings.some(
      (warning) => warning.includes("Vercel") && warning.includes("cannot see or verify"),
    ),
  );
});

test("hardened profile fails without CRON_SECRET", () => {
  const report = runDeploymentReadiness("hardened", VALID_CORE_ENV);
  assert.equal(report.ok, false);
  const cronItem = report.profileRequired.find((item) => item.key === "CRON_SECRET");
  assert.equal(cronItem?.status, "missing");
});

test("hardened profile passes once CRON_SECRET is set alongside valid core configuration", () => {
  const report = runDeploymentReadiness("hardened", {
    ...VALID_CORE_ENV,
    CRON_SECRET: "a-header-safe-secret",
  });
  assert.equal(report.ok, true);
  const cronItem = report.profileRequired.find((item) => item.key === "CRON_SECRET");
  assert.equal(cronItem?.status, "ok");
});

test("hardened profile always documents GitHub-side configuration it cannot verify", () => {
  const report = runDeploymentReadiness("hardened", {
    ...VALID_CORE_ENV,
    CRON_SECRET: "a-header-safe-secret",
  });
  assert.ok(
    report.warnings.some(
      (warning) =>
        warning.includes("GitHub") && warning.includes("cannot see or verify"),
    ),
  );
  assert.ok(
    report.warnings.some((warning) => warning.includes("HARDENED_RELEASE_REPOSITORY")),
  );
});

test("either profile still fails when core configuration is missing", () => {
  for (const profile of ["basic", "hardened"] as const) {
    const report = runDeploymentReadiness(profile, {});
    assert.equal(report.ok, false);
    assert.ok(report.core.some((item) => item.status !== "ok"));
  }
});

test("optional integrations are reported the same way regardless of profile", () => {
  const withResend = runDeploymentReadiness("basic", {
    ...VALID_CORE_ENV,
    RESEND_API_KEY: "re_test_key",
  });
  const resendGroup = withResend.optional.find((group) => group.group === "resend");
  assert.equal(resendGroup?.configured, true);
});

test("never includes a raw secret value anywhere in the report", () => {
  const secretValue = "super-secret-value-should-not-leak";
  for (const profile of ["basic", "hardened"] as const) {
    const report = runDeploymentReadiness(profile, {
      ...VALID_CORE_ENV,
      RESEND_API_KEY: secretValue,
      CRON_SECRET: secretValue,
      ADMIN_PASSWORD: secretValue,
    });
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, new RegExp(secretValue));
  }
});
