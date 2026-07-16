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

test("workflow rejects an empty legacy 200 after a retryable failure", () => {
  const result = runSequence("empty-success", [
    `22\t503\t${response("retryable_failure", {
      retryableFailures: 1,
      unscheduledRetryableFailures: 1,
    })}`,
    '0\t200\t{"ok":true,"results":[]}',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /invalid scheduler JSON/);
});
