import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("reports AIC from OpenTelemetry when JSON checkpoint is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "contact-research-aic-"));
  try {
    const fakeCopilot = join(directory, "copilot");
    const metricsFile = join(directory, "metrics.json");
    const usageFile = join(directory, "usage.jsonl");
    writeFileSync(
      fakeCopilot,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH, JSON.stringify({
  type: "span",
  name: "invoke_agent",
  parentSpanId: null,
  attributes: { "github.copilot.nano_aiu": 7250000000 }
}) + "\\n");
console.log(JSON.stringify({ type: "result", exitCode: 0 }));
`
    );
    chmodSync(fakeCopilot, 0o755);
    writeFileSync(
      metricsFile,
      JSON.stringify({
        artistBySession: { "session-1": "Gabatron" },
      })
    );

    const result = spawnSync(
      process.execPath,
      [
        new URL(
          "./run-contact-research-copilot.mjs",
          import.meta.url
        ).pathname,
        "test prompt",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          CONTACT_RESEARCH_AGENT_SESSION: "session-1",
          CONTACT_RESEARCH_BROKER_METRICS_FILE: metricsFile,
          CONTACT_RESEARCH_USAGE_FILE: usageFile,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AI credits for Gabatron: 7\.250 AIC/);
    assert.equal(
      JSON.parse(readFileSync(usageFile, "utf8")).nanoAiu,
      7_250_000_000
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
