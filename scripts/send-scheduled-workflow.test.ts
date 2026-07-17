import assert from "node:assert/strict";
import {
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflow = fileURLToPath(
  new URL("../.github/workflows/send-scheduled.yml", import.meta.url),
);
const mockCurl = fileURLToPath(
  new URL("./test-fixtures/mock-curl.sh", import.meta.url),
);

function workflowScript(): string {
  const source = readFileSync(workflow, "utf8");
  const match = source.match(/        run: \|\n([\s\S]+)$/);
  assert.ok(match, "Missing scheduled outreach workflow script");
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function response(
  state:
    | "complete"
    | "pending_claims"
    | "scheduled_retries"
    | "retryable_failure"
    | "terminal_failure"
    | "bounded",
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ok: state !== "retryable_failure" && state !== "terminal_failure",
    complete: state === "complete",
    state,
    terminalFailures: 0,
    retryableFailures: 0,
    unscheduledRetryableFailures: 0,
    retriesScheduled: 0,
    scheduledRetries: 0,
    pendingClaims: 0,
    bounded: false,
    nextRetryAt: null,
    nextClaimExpiryAt: null,
    ...overrides,
  });
}

function legacyResponse(
  results: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ok: true,
    dispatched: results.length,
    results,
    ...overrides,
  });
}

function runSequence(name: string, rows: string[]) {
  const stem = fileURLToPath(
    new URL(`./test-fixtures/.send-scheduled-${process.pid}-${name}`, import.meta.url),
  );
  const responsesFile = `${stem}.responses`;
  const stateFile = `${stem}.state`;
  writeFileSync(responsesFile, `${rows.join("\n")}\n`);
  try {
    return spawnSync("bash", ["-c", workflowScript()], {
      encoding: "utf8",
      env: {
        ...process.env,
        APP_BASE_URL: "https://photo-admin.invalid",
        CRON_SECRET: "test-secret",
        CURL_BIN: mockCurl,
        SLEEP_BIN: "/usr/bin/true",
        MOCK_CURL_RESPONSES_FILE: responsesFile,
        MOCK_CURL_STATE_FILE: stateFile,
      },
      maxBuffer: 1024 * 1024,
    });
  } finally {
    for (const path of [responsesFile, stateFile]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
}

test("workflow keeps retryable failures and fresh claims sticky past the soft poll cap", () => {
  const rows = [
    `22\t503\t${response("retryable_failure", {
      retryableFailures: 1,
      unscheduledRetryableFailures: 1,
    })}`,
    ...Array.from(
      { length: 9 },
      () =>
        `0\t202\t${response("pending_claims", {
          pendingClaims: 1,
        })}`,
    ),
    `0\t200\t${response("complete")}`,
  ];
  const result = runSequence("sticky", rows);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state pending_claims remains pending/);
  assert.match(result.stdout, /Outreach dispatch attempt 11/);
  assert.match(result.stdout, /Outreach dispatch succeeded/);
});

test("workflow rejects an incomplete legacy 200 after a transport retry", () => {
  const result = runSequence("empty-success", [
    "28\t000\t",
    '0\t200\t{"ok":true}',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /invalid scheduler JSON/);
});

test("workflow accepts a clean zero-row legacy response with a warning", () => {
  const result = runSequence("legacy-zero", [
    `0\t200\t${legacyResponse([])}`,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /warning::Outreach dispatch used legacy scheduler response compatibility/,
  );
  assert.match(result.stdout, /Outreach dispatch succeeded with HTTP 200/);
});

test("workflow accepts clean legacy rows after a transport retry", () => {
  const result = runSequence("legacy-after-transport", [
    "28\t000\t",
    `0\t200\t${legacyResponse([
      { id: "first", ok: true },
      { id: "second", ok: true },
    ])}`,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /curl status 28 and HTTP 000; retrying/);
  assert.match(
    result.stdout,
    /warning::Outreach dispatch used legacy scheduler response compatibility/,
  );
});

test("workflow rejects a failed legacy row after a transport retry", () => {
  const result = runSequence("legacy-failed-row", [
    "28\t000\t",
    `0\t200\t${legacyResponse([
      { id: "failed", ok: false, error: "provider rejected request" },
    ])}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /invalid scheduler JSON/);
});

test("workflow rejects a false legacy top-level status", () => {
  const result = runSequence("legacy-false", [
    `0\t200\t${legacyResponse([], { ok: false })}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /invalid scheduler JSON/);
});

test("workflow rejects malformed or ambiguous legacy fields", async (t) => {
  const cases: Array<[string, string]> = [
    ["missing-dispatched", '{"ok":true,"results":[]}'],
    ["negative-dispatched", legacyResponse([], { dispatched: -1 })],
    ["fractional-dispatched", legacyResponse([], { dispatched: 0.5 })],
    ["string-dispatched", legacyResponse([], { dispatched: "0" })],
    ["non-array-results", legacyResponse([], { results: {} })],
    ["missing-row-ok", legacyResponse([{ id: "missing-ok" }])],
    ["non-boolean-row-ok", legacyResponse([{ id: "string-ok", ok: "true" }])],
    ["row-error", legacyResponse([{ id: "error", ok: true, error: "failed" }])],
    [
      "terminal-disposition",
      legacyResponse([{ id: "terminal", ok: true, disposition: "terminal" }]),
    ],
    [
      "malformed-structured-fallback",
      legacyResponse([], { state: "unknown", complete: true }),
    ],
    ["empty-object", "{}"],
  ];

  for (const [name, body] of cases) {
    await t.test(name, () => {
      const result = runSequence(`legacy-malformed-${name}`, [
        `0\t200\t${body}`,
      ]);

      assert.equal(result.status, 1);
      assert.match(result.stdout, /invalid scheduler JSON/);
    });
  }
});

test("workflow keeps structured terminal failures sticky across a legacy response", () => {
  const result = runSequence("terminal-then-legacy", [
    `0\t200\t${response("terminal_failure", {
      terminalFailures: 1,
      pendingClaims: 1,
    })}`,
    `0\t200\t${legacyResponse([])}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /reported 1 terminal row failure/);
  assert.match(
    result.stdout,
    /legacy response cannot clear 1 previously reported terminal row failure/,
  );
  assert.doesNotMatch(
    result.stdout,
    /used legacy scheduler response compatibility/,
  );
});

test("workflow continues to prefer a valid structured response", () => {
  const result = runSequence("structured-complete", [
    `0\t200\t${JSON.stringify({
      ...JSON.parse(response("complete")),
      dispatched: 0,
      results: [],
    })}`,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Outreach dispatch succeeded with HTTP 200/);
  assert.doesNotMatch(
    result.stdout,
    /used legacy scheduler response compatibility/,
  );
});
