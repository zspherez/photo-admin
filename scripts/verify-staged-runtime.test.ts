import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./verify-staged-runtime.sh", import.meta.url)
);
const mockNpm = fileURLToPath(
  new URL("./test-fixtures/mock-release-npm.sh", import.meta.url)
);
const mockVercel = fileURLToPath(
  new URL("./test-fixtures/mock-release-vercel.sh", import.meta.url)
);
const deployment = "https://photo-admin-release.vercel.app";
const releaseSha = "a".repeat(40);
const nonce = Buffer.alloc(32, 9).toString("base64url");
const appBaseUrl = "https://photo-admin.example";
const cronSecret = "cron-secret-must-not-be-logged";
const vercelToken = "vercel-token-must-not-be-logged";

function runtimeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    nonce,
    releaseSha,
    expiresAt: Date.now() + 25 * 60 * 1_000,
    ...overrides,
  });
}

function runVerification(
  name: string,
  overrides: Record<string, string | undefined> = {}
) {
  const stateFile = fileURLToPath(
    new URL(
      `./test-fixtures/.release-runtime-${process.pid}-${name}`,
      import.meta.url
    )
  );
  const runtimeStateFile = `${stateFile}.runtime`;
  try {
    const result = spawnSync("bash", [script, deployment, releaseSha], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://runtime@example.test/photo_admin",
        DIRECT_URL: "postgresql://direct@example.test/photo_admin",
        APP_BASE_URL: appBaseUrl,
        CRON_SECRET: cronSecret,
        VERCEL_TOKEN: vercelToken,
        NPM_BIN: mockNpm,
        VERCEL_BIN: mockVercel,
        SLEEP_BIN: "/usr/bin/true",
        MOCK_RELEASE_NONCE: nonce,
        MOCK_RELEASE_STATE_FILE: stateFile,
        MOCK_RUNTIME_STATE_FILE: runtimeStateFile,
        MOCK_RUNTIME_BODY: runtimeBody(),
        MOCK_EXPECT_AUTHORIZATION_HEADER: `Authorization: Bearer ${cronSecret}`,
        MOCK_EXPECT_APP_BASE_URL_HEADER:
          `X-Photo-Admin-Release-App-Base-URL: ${appBaseUrl}`,
        MOCK_EXPECT_RELEASE_SHA_HEADER:
          `X-Photo-Admin-Release-SHA: ${releaseSha}`,
        MOCK_EXPECT_DEPLOYMENT: deployment,
        MOCK_EXPECT_VERCEL_TOKEN: vercelToken,
        ...overrides,
      },
    });
    let state = "";
    try {
      state = readFileSync(stateFile, "utf8");
    } catch {}
    return { ...result, state };
  } finally {
    for (const path of [stateFile, runtimeStateFile]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

test("staged runtime proof verifies the marker and cleans it before success", () => {
  const result = runVerification("success");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "create\ncleanup\n");
  assert.match(
    result.stdout,
    /Verified staged runtime database, APP_BASE_URL, and CRON_SECRET/
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(`${nonce}|${cronSecret}|${vercelToken}`)
  );
});

test("Vercel authentication stays in the environment instead of reaching curl", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /"\$\{vercel_bin\}" curl/);
  assert.doesNotMatch(
    source,
    /"\$\{vercel_bin\}"[\s\S]*--token "\$\{VERCEL_TOKEN\}"/,
  );
});

test("wrong staged database marker fails before pause and still cleans the candidate marker", () => {
  const result = runVerification("wrong-database", {
    MOCK_RUNTIME_BODY: runtimeBody({ nonce: Buffer.alloc(32, 10).toString("base64url") }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.state, "create\ncleanup\n");
  assert.match(result.stderr, /did not return the fresh release runtime verification marker/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(`${nonce}|${cronSecret}|${vercelToken}`)
  );
});

test("malformed and stale staged marker responses fail closed and clean up", async (t) => {
  for (const [name, body] of [
    ["malformed", '{"nonce":"broken"}'],
    ["stale", runtimeBody({ expiresAt: Date.now() - 1 })],
  ] as const) {
    await t.test(name, () => {
      const result = runVerification(name, { MOCK_RUNTIME_BODY: body });
      assert.equal(result.status, 1);
      assert.equal(result.state, "create\ncleanup\n");
      assert.match(result.stderr, /did not return the fresh release runtime verification marker/);
    });
  }
});

test("authentication or deployment protection failure cleans the marker", () => {
  const result = runVerification("unauthorized", {
    MOCK_RUNTIME_HTTP_STATUS: "401",
    MOCK_RUNTIME_CURL_STATUS: "22",
  });

  assert.equal(result.status, 1);
  assert.equal(result.state, "create\ncleanup\n");
  assert.match(result.stderr, /curl 22, HTTP 401/);
});

test("staged route propagation retries transient 404 responses", () => {
  const result = runVerification("propagation", {
    MOCK_RUNTIME_HTTP_SEQUENCE: "404,404,200",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state, "create\ncleanup\n");
  assert.match(result.stderr, /HTTP 404.*retrying in 5s/);
  assert.match(result.stderr, /HTTP 404.*retrying in 10s/);
});

test("cleanup failure prevents pausing even after a valid staged response", () => {
  const result = runVerification("cleanup-failure", {
    MOCK_RELEASE_CLEANUP_STATUS: "1",
  });

  assert.equal(result.status, 1);
  assert.ok((result.state.match(/^cleanup$/gm) ?? []).length >= 1);
  assert.match(result.stderr, /could not be cleaned before pausing/);
});
