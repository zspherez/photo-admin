import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./vercel-project-state.sh", import.meta.url)
);
const mockCurl = fileURLToPath(
  new URL("./test-fixtures/mock-curl.sh", import.meta.url)
);

function run(
  operation: "pause" | "unpause",
  httpStatus: string,
  body = ""
) {
  return spawnSync("bash", [script, operation], {
    encoding: "utf8",
    env: {
      ...process.env,
      CURL_BIN: mockCurl,
      MOCK_CURL_BODY: body,
      MOCK_CURL_HTTP_STATUS: httpStatus,
      VERCEL_ORG_ID: "test-org",
      VERCEL_PROJECT_ID: "test-project",
      VERCEL_STATE_MAX_ATTEMPTS: "1",
      VERCEL_STATE_RETRY_DELAY_SECONDS: "0",
      VERCEL_TOKEN: "test-token-must-not-be-logged",
    },
  });
}

test("Vercel pause and unpause accept successful mocked responses", () => {
  assert.equal(run("pause", "200").status, 0);
  assert.equal(run("unpause", "204").status, 0);
});

test("Vercel unpause is idempotent when the mocked API says it is running", () => {
  const result = run("unpause", "409", '{"error":"Project is not paused"}');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /already running/);
});

test("Vercel pause is idempotent when the mocked API says it is paused", () => {
  const result = run("pause", "409", '{"error":"Project is already paused"}');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /already paused/);
});

test("Vercel state failures do not print the access token", () => {
  const result = run("unpause", "403", '{"error":"forbidden"}');
  assert.equal(result.status, 1);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /test-token-must-not-be-logged/
  );
});
