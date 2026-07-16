import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseWorkflow = fileURLToPath(
  new URL("../.github/workflows/release-production.yml", import.meta.url)
);
const recoveryScript = fileURLToPath(
  new URL("./recover-production-release.sh", import.meta.url)
);
const deploymentScript = fileURLToPath(
  new URL("./verify-vercel-deployment.sh", import.meta.url)
);
const mockCurl = fileURLToPath(
  new URL("./test-fixtures/mock-curl.sh", import.meta.url)
);
const mockVercel = fileURLToPath(
  new URL("./test-fixtures/mock-vercel.sh", import.meta.url)
);
const releaseSha = "a".repeat(40);
const projectFingerprint = createHash("sha256")
  .update("test-org\ntest-project\n")
  .digest("hex");
const deployment = JSON.stringify({
  projectId: "test-project",
  target: "production",
  readyState: "READY",
  meta: { releaseCommit: releaseSha },
});

function workflowStep(workflow: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflow.match(
    new RegExp(
      `      - name: ${escapedName}\\n([\\s\\S]*?)(?=\\n      - name:|$)`
    )
  );
  assert.ok(match, `Missing workflow step: ${name}`);
  return match[1];
}

function workflowRunScript(workflow: string, name: string) {
  const step = workflowStep(workflow, name);
  const match = step.match(/        run: \|\n([\s\S]*)$/);
  assert.ok(match, `Missing run script for workflow step: ${name}`);
  return match[1]
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

function baseEnvironment() {
  return {
    ...process.env,
    CURL_BIN: mockCurl,
    MOCK_CURL_BODY: deployment,
    MOCK_CURL_EXPECT_AUTHORIZATION_HEADER:
      "Authorization: Bearer test-token-must-not-be-logged",
    MOCK_CURL_HTTP_STATUS: "200",
    EXPECTED_PROJECT_FINGERPRINT: projectFingerprint,
    VERCEL_DEPLOYMENT_VERIFY_MAX_ATTEMPTS: "1",
    VERCEL_DEPLOYMENT_VERIFY_RETRY_SECONDS: "0",
    VERCEL_ORG_ID: "test-org",
    VERCEL_PROJECT_ID: "test-project",
    VERCEL_STATE_MAX_ATTEMPTS: "1",
    VERCEL_STATE_RETRY_DELAY_SECONDS: "0",
    VERCEL_TOKEN: "test-token-must-not-be-logged",
  };
}

test("watchdog timeout covers every bounded recovery stage and preserves unpause reserve", () => {
  const workflow = readFileSync(releaseWorkflow, "utf8");
  const recoveryJob = workflow.slice(workflow.indexOf("\n  recovery:"));
  assert.match(recoveryJob, /\n    timeout-minutes: 60\n/);

  const contextGate = workflowStep(
    recoveryJob,
    "Reassert trusted watchdog context"
  );
  const setup = workflowStep(recoveryJob, "Set up Node.js");
  const validate = workflowStep(
    recoveryJob,
    "Validate dedicated recovery environment"
  );
  const install = workflowStep(
    recoveryJob,
    "Install pinned Vercel CLI for recovery promotion"
  );
  const recover = workflowStep(
    recoveryJob,
    "Recover only a provably safe target"
  );

  assert.match(contextGate, /        timeout-minutes: 1\n/);
  assert.match(setup, /        timeout-minutes: 5\n/);
  assert.match(validate, /        timeout-minutes: 1\n/);
  assert.match(install, /        timeout-minutes: 10\n/);
  assert.match(install, /        if: \$\{\{ always\(\) &&/);
  assert.match(recover, /        timeout-minutes: 30\n/);
  assert.match(recover, /        if: \$\{\{ always\(\) &&/);
  assert.match(
    recover,
    /EXPECTED_PROJECT_FINGERPRINT: \$\{\{ needs\.recovery_preflight\.outputs\.project_fingerprint \}\}/
  );

  const verifyAttempts = 6;
  const verifyRequestSeconds = 60;
  const verifyRetrySeconds = 10;
  const verificationLoopSeconds =
    verifyAttempts * verifyRequestSeconds +
    (verifyAttempts - 1) * verifyRetrySeconds;
  const promotionSeconds = 5 * 60;
  const unpauseAttempts = 3;
  const unpauseRequestSeconds = 60;
  const unpauseRetrySeconds = 5;
  const unpauseSeconds =
    unpauseAttempts * unpauseRequestSeconds +
    (unpauseAttempts - 1) * unpauseRetrySeconds;
  const recoveryWorstCaseSeconds =
    60 + 2 * verificationLoopSeconds + promotionSeconds + unpauseSeconds;
  const recoveryStepSeconds = 30 * 60;
  const jobSeconds = 60 * 60;
  const boundedStepSeconds = (1 + 5 + 1 + 10 + 30) * 60;

  assert.match(
    recover,
    /VERCEL_DEPLOYMENT_VERIFY_MAX_ATTEMPTS: "6"/
  );
  assert.match(
    recover,
    /VERCEL_DEPLOYMENT_VERIFY_RETRY_SECONDS: "10"/
  );
  assert.match(recover, /VERCEL_STATE_MAX_ATTEMPTS: "3"/);
  assert.match(recover, /VERCEL_STATE_RETRY_DELAY_SECONDS: "5"/);
  assert.ok((recover.match(/--max-time 60/g) ?? []).length >= 2);
  assert.match(recover, /--timeout=5m/);
  assert.equal(
    recover.match(
      /verify_deployment "\$\{RELEASE_TARGET_URL\}" "\$\{TRUSTED_RELEASE_SHA\}"/g
    )?.length,
    2
  );
  assert.equal(recoveryWorstCaseSeconds, 22 * 60 + 50);
  assert.ok(
    recoveryStepSeconds - recoveryWorstCaseSeconds >= 5 * 60,
    "recovery step must retain at least five minutes beyond the full unpause budget"
  );
  assert.ok(
    jobSeconds - boundedStepSeconds >= 5 * 60,
    "watchdog job must retain at least five minutes beyond all bounded stages"
  );
});

test("every unconditional recovery path seals and authenticates the project itself", () => {
  const workflow = readFileSync(releaseWorkflow, "utf8");
  const releaseJob = workflow.slice(
    workflow.indexOf("\n  release:"),
    workflow.indexOf("\n  recovery:")
  );
  const inJobRecovery = workflowStep(
    releaseJob,
    "Attempt safe in-job recovery with approved credentials"
  );
  const recoveryJob = workflow.slice(workflow.indexOf("\n  recovery:"));
  const watchdogRecovery = workflowRunScript(
    recoveryJob,
    "Recover only a provably safe target"
  );
  const helper = readFileSync(recoveryScript, "utf8");

  assert.match(inJobRecovery, /if: \$\{\{ always\(\) &&/);
  assert.match(
    inJobRecovery,
    /EXPECTED_PROJECT_FINGERPRINT: \$\{\{ needs\.recovery_preflight\.outputs\.project_fingerprint \}\}/
  );
  assert.ok(
    helper.indexOf("actual_project_fingerprint=") <
      helper.indexOf('project_endpoint="https://api.vercel.com/v9/projects/')
  );
  assert.ok(
    helper.indexOf('project_endpoint="https://api.vercel.com/v9/projects/') <
      helper.indexOf('if [[ "${RELEASE_SCHEMA_STARTED}" != "true" ]]')
  );
  assert.ok(
    watchdogRecovery.indexOf("actual_project_fingerprint=") <
      watchdogRecovery.indexOf("authenticate_project()")
  );
  const watchdogAuthenticationCall = watchdogRecovery.lastIndexOf(
    "\nauthenticate_project\n"
  );
  assert.ok(watchdogAuthenticationCall >= 0);
  assert.ok(
    watchdogAuthenticationCall <
      watchdogRecovery.indexOf(
        'if [[ "${RELEASE_SCHEMA_STARTED}" != "true" ]]'
      )
  );
  assert.ok(
    watchdogAuthenticationCall <
      watchdogRecovery.indexOf('verify_deployment "${RELEASE_TARGET_URL}"')
  );
});

test("recovery credentials are main-only environment secrets and execute no checkout code", () => {
  const workflow = readFileSync(releaseWorkflow, "utf8");
  const preflightStart = workflow.indexOf("\n  recovery_preflight:");
  const releaseStart = workflow.indexOf("\n  release:");
  const recoveryStart = workflow.indexOf("\n  recovery:");
  assert.ok(preflightStart > 0);
  assert.ok(releaseStart > preflightStart);
  assert.ok(recoveryStart > releaseStart);

  const trustSource = workflow.slice(0, preflightStart);
  const preflightSource = workflow.slice(preflightStart, releaseStart);
  const releaseSource = workflow.slice(releaseStart, recoveryStart);
  const recoverySource = workflow.slice(recoveryStart);

  assert.match(trustSource, /GITHUB_REF}" != "refs\/heads\/main"/);
  assert.match(trustSource, /GITHUB_REPOSITORY}" != "zspherez\/photo-admin"/);
  assert.match(
    trustSource,
    /git merge-base --is-ancestor "\$\{release_sha\}" "\$\{main_sha\}"/
  );
  assert.match(
    trustSource,
    /ref: refs\/heads\/main[\s\S]*persist-credentials: false/
  );

  assert.match(
    preflightSource,
    /environment:\s*\n\s+name: production-recovery/
  );
  assert.match(
    preflightSource,
    /RECOVERY_ENVIRONMENT_GUARD}" != "production-recovery-main-only-v1"/
  );
  assert.doesNotMatch(preflightSource, /actions\/checkout|inputs\./);

  assert.equal(
    (workflow.match(/^\s+name: production$/gm) ?? []).length,
    1
  );
  assert.equal(
    (workflow.match(/^\s+name: production-recovery$/gm) ?? []).length,
    2
  );
  assert.doesNotMatch(releaseSource, /secrets\.RECOVERY_VERCEL_/);
  assert.match(
    releaseSource,
    /ref: \$\{\{ needs\.trust\.outputs\.release_sha \}\}/
  );

  assert.match(
    recoverySource,
    /environment:\s*\n\s+name: production-recovery/
  );
  assert.match(recoverySource, /github\.ref == 'refs\/heads\/main'/);
  assert.match(recoverySource, /github\.repository == 'zspherez\/photo-admin'/);
  assert.match(
    recoverySource,
    /REPORTED_RELEASE_SHA[\s\S]*TRUSTED_RELEASE_SHA/
  );
  assert.match(recoverySource, /\[A-Za-z0-9-\]\+\\\.vercel\\\.app/);
  assert.doesNotMatch(
    recoverySource,
    /actions\/checkout|recover-production-release\.sh|scripts\/|inputs\./
  );
});

test("recovery environment setup documents the non-review main-only boundary", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8"
  );
  const recoverySetup = readme.slice(
    readme.indexOf("Configure **`production-recovery`** separately:"),
    readme.indexOf("To release, push the revision to `main`")
  );

  assert.match(recoverySetup, /Do \*\*not\*\* configure required reviewers/);
  assert.match(recoverySetup, /Selected branches and\s+tags/);
  assert.match(recoverySetup, /branch rule `main`/);
  assert.match(recoverySetup, /add no tag rules/);
  assert.match(recoverySetup, /RECOVERY_ENVIRONMENT_GUARD/);
  assert.match(recoverySetup, /production-recovery-main-only-v1/);
  assert.match(recoverySetup, /Delete every repository-level/);
  assert.match(
    readme,
    /cannot enforce an environment's\s+deployment branch policy/
  );
});

test("inline watchdog preserves conservative promotion and resume semantics", () => {
  const workflow = readFileSync(releaseWorkflow, "utf8");
  const recoveryJob = workflow.slice(workflow.indexOf("\n  recovery:"));
  const recoveryRun = workflowRunScript(
    recoveryJob,
    "Recover only a provably safe target"
  );
  const validationRun = workflowRunScript(
    recoveryJob,
    "Validate dedicated recovery environment"
  );
  const harness = `
curl() { bash "$MOCK_CURL_BIN" "$@"; }
vercel() { bash "$MOCK_VERCEL_BIN" "$@"; }
${recoveryRun}
`;
  const watchdogEnvironment = {
    ...baseEnvironment(),
    MOCK_CURL_BIN: mockCurl,
    MOCK_VERCEL_BIN: mockVercel,
    EXPECTED_PROJECT_FINGERPRINT: projectFingerprint,
    RECOVERY_ENVIRONMENT_GUARD: "production-recovery-main-only-v1",
    RELEASE_OWNERSHIP_READY: "false",
    RELEASE_PAUSE_REQUESTED: "true",
    RELEASE_SCHEMA_READY: "false",
    RELEASE_SCHEMA_STARTED: "false",
    RELEASE_STAGED_VERIFIED: "false",
    RELEASE_TARGET_PROMOTED: "false",
    RELEASE_TARGET_URL: "",
    REPORTED_RELEASE_SHA: releaseSha,
    TRUSTED_RELEASE_SHA: releaseSha,
  };

  const preSchema = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: watchdogEnvironment,
  });
  assert.equal(preSchema.status, 0, preSchema.stderr);
  assert.match(preSchema.stdout, /still-compatible old target/);
  assert.match(preSchema.stdout, /unpause request succeeded/);

  const uncertain = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...watchdogEnvironment,
      RELEASE_SCHEMA_STARTED: "true",
    },
  });
  assert.equal(uncertain.status, 1);
  assert.match(uncertain.stdout, /remains paused/);
  assert.doesNotMatch(uncertain.stdout, /unpause request succeeded/);

  const verified = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...watchdogEnvironment,
      RELEASE_OWNERSHIP_READY: "true",
      RELEASE_SCHEMA_READY: "true",
      RELEASE_SCHEMA_STARTED: "true",
      RELEASE_STAGED_VERIFIED: "true",
      RELEASE_TARGET_URL: "https://target-test.vercel.app",
    },
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /mock-vercel promote/);
  assert.match(verified.stdout, /Exact target promotion/);
  assert.match(verified.stdout, /unpause request succeeded/);
  assert.doesNotMatch(
    `${verified.stdout}\n${verified.stderr}`,
    /test-token-must-not-be-logged/
  );

  const precedingValidationFailure = spawnSync(
    "bash",
    [
      "-c",
      `
curl() { bash "$MOCK_CURL_BIN" "$@"; }
vercel() { bash "$MOCK_VERCEL_BIN" "$@"; }
(
  export EXPECTED_PROJECT_FINGERPRINT="${"0".repeat(64)}"
${validationRun}
)
validation_status=$?
if [[ "\${validation_status}" -eq 0 ]]; then
  echo "expected preceding validation failure" >&2
  exit 2
fi
${recoveryRun}
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...watchdogEnvironment,
        RELEASE_OWNERSHIP_READY: "true",
        RELEASE_SCHEMA_READY: "true",
        RELEASE_SCHEMA_STARTED: "true",
        RELEASE_STAGED_VERIFIED: "true",
        RELEASE_TARGET_URL: "https://target-test.vercel.app",
      },
    }
  );
  assert.equal(
    precedingValidationFailure.status,
    0,
    precedingValidationFailure.stderr
  );
  assert.match(precedingValidationFailure.stdout, /mock-vercel promote/);

  const changedCredentials = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...watchdogEnvironment,
      RELEASE_SCHEMA_STARTED: "false",
      VERCEL_TOKEN: "changed-token-must-not-be-logged",
    },
  });
  assert.equal(changedCredentials.status, 1);
  assert.match(changedCredentials.stdout, /cannot authenticate/);
  assert.doesNotMatch(changedCredentials.stdout, /unpause request succeeded/);
  assert.doesNotMatch(
    `${changedCredentials.stdout}\n${changedCredentials.stderr}`,
    /changed-token-must-not-be-logged|test-token-must-not-be-logged/
  );

  const wrongProject = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...watchdogEnvironment,
      RELEASE_SCHEMA_STARTED: "false",
      VERCEL_PROJECT_ID: "wrong-project",
    },
  });
  assert.equal(wrongProject.status, 1);
  assert.match(wrongProject.stdout, /fingerprint does not match/);
  assert.doesNotMatch(wrongProject.stdout, /unpause request succeeded/);
});

test("deployment verification binds readiness, production target, project, and SHA", () => {
  const result = spawnSync(
    "bash",
    [deploymentScript, "https://target.example.vercel.app", releaseSha],
    { encoding: "utf8", env: baseEnvironment() }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exact release SHA/);

  const mismatch = spawnSync(
    "bash",
    [deploymentScript, "https://target.example.vercel.app", "b".repeat(40)],
    { encoding: "utf8", env: baseEnvironment() }
  );
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /did not match/);
});

test("pre-schema recovery idempotently resumes the old compatible target", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "false",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /old target/);
  assert.match(result.stdout, /unpause request succeeded/);
});

test("in-job recovery rejects changed credentials before a production operation", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "false",
      VERCEL_TOKEN: "changed-token-must-not-be-logged",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot authenticate/);
  assert.doesNotMatch(result.stdout, /unpause request succeeded/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /changed-token-must-not-be-logged|test-token-must-not-be-logged/
  );
});

test("in-job recovery rejects the wrong project before a production operation", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "false",
      VERCEL_PROJECT_ID: "wrong-project",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fingerprint does not match/);
  assert.doesNotMatch(result.stdout, /unpause request succeeded/);
});

test("uncertain schema cutover remains paused and fails visibly", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "true",
      RELEASE_SCHEMA_READY: "false",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remains paused/);
  assert.doesNotMatch(result.stdout, /unpause request succeeded/);
});

test("verified schema without Sheet ownership remains paused", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "true",
      RELEASE_SCHEMA_READY: "true",
      RELEASE_SHA: releaseSha,
      RELEASE_STAGED_VERIFIED: "true",
      RELEASE_TARGET_PROMOTED: "true",
      RELEASE_TARGET_URL: "https://target.example.vercel.app",
      VERCEL_BIN: mockVercel,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Sheet adoption/);
  assert.doesNotMatch(result.stdout, /mock-vercel promote/);
  assert.doesNotMatch(result.stdout, /unpause request succeeded/);
});

test("verified cutover recovery promotes the exact staged target before resume", () => {
  const result = spawnSync("bash", [recoveryScript], {
    encoding: "utf8",
    env: {
      ...baseEnvironment(),
      RELEASE_PAUSE_REQUESTED: "true",
      RELEASE_SCHEMA_STARTED: "true",
      RELEASE_SCHEMA_READY: "true",
      RELEASE_OWNERSHIP_READY: "true",
      RELEASE_SHA: releaseSha,
      RELEASE_STAGED_VERIFIED: "true",
      RELEASE_TARGET_PROMOTED: "false",
      RELEASE_TARGET_URL: "https://target.example.vercel.app",
      VERCEL_BIN: mockVercel,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mock-vercel promote/);
  assert.match(result.stdout, /Exact target promotion/);
  assert.match(result.stdout, /unpause request succeeded/);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /test-token-must-not-be-logged/
  );
});
