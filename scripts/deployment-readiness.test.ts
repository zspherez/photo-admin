import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("./deployment-readiness.ts", import.meta.url),
);
const tsxBin = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);

const VALID_CORE_ENV = {
  DATABASE_URL: "postgresql://localhost:6543/postgres",
  DIRECT_URL: "postgresql://localhost:5432/postgres",
  APP_BASE_URL: "http://127.0.0.1:3000",
  ADMIN_PASSWORD: "test-admin-password",
  ADMIN_SESSION_SECRET: "test-session-secret",
};

function run(args: readonly string[], env: Record<string, string | undefined>) {
  return spawnSync(tsxBin, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("defaults to the basic profile and exits nonzero with incomplete core configuration", () => {
  const result = run([], {
    ...process.env,
    DATABASE_URL: "",
    DIRECT_URL: "",
    APP_BASE_URL: "",
    ADMIN_PASSWORD: "",
    ADMIN_SESSION_SECRET: "",
    ALLOW_INSECURE_OPEN_MODE: "",
    DEPLOYMENT_PROFILE: "",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Deployment profile: basic/);
  assert.match(result.stdout, /MISSING.*Pooled Postgres connection/);
});

test("exits zero for the basic profile once required core configuration is valid", () => {
  const result = run(["--profile=basic"], VALID_CORE_ENV);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /looks complete/);
});

test("hardened profile requires CRON_SECRET beyond core configuration", () => {
  const missing = run(["--profile=hardened"], VALID_CORE_ENV);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /MISSING.*Release runtime verification shared secret/s);

  const present = run(["--profile=hardened"], {
    ...VALID_CORE_ENV,
    CRON_SECRET: "a-header-safe-secret",
  });
  assert.equal(present.status, 0, present.stderr);
});

test("DEPLOYMENT_PROFILE env selects a profile when --profile is omitted", () => {
  const result = run([], { ...VALID_CORE_ENV, DEPLOYMENT_PROFILE: "hardened" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Deployment profile: hardened/);
});

test("an explicit --profile wins over DEPLOYMENT_PROFILE", () => {
  const result = run(["--profile=basic"], {
    ...VALID_CORE_ENV,
    DEPLOYMENT_PROFILE: "hardened",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deployment profile: basic/);
});

test("fails closed with a clear error for an unrecognized profile", () => {
  const result = run(["--profile=production"], VALID_CORE_ENV);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown deployment profile/);
});

test("rejects unknown arguments", () => {
  const result = run(["--not-a-real-flag"], VALID_CORE_ENV);
  assert.equal(result.status, 1);
});

test("--json prints valid, parseable JSON matching the human-readable status", () => {
  const result = run(["--profile=basic", "--json"], VALID_CORE_ENV);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profile, "basic");
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.core));
  assert.ok(Array.isArray(report.profileRequired));
  assert.ok(Array.isArray(report.optional));
  assert.ok(Array.isArray(report.warnings));
});

test("never prints a raw secret value in human or JSON output", () => {
  const secretValue = "super-secret-cli-value-should-not-leak";
  for (const jsonFlag of [[], ["--json"]] as const) {
    const result = run(["--profile=hardened", ...jsonFlag], {
      ...VALID_CORE_ENV,
      ADMIN_PASSWORD: secretValue,
      CRON_SECRET: secretValue,
      RESEND_API_KEY: secretValue,
    });
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(secretValue),
    );
  }
});
