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

test("pins GPT-6.1 Sol for research and audit sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "contact-agent-model-"));
  try {
    const fakeCopilot = join(directory, "copilot");
    const argsFile = join(directory, "args.json");
    writeFileSync(
      fakeCopilot,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.TEST_COPILOT_ARGS, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "result", exitCode: 0 }));
`
    );
    chmodSync(fakeCopilot, 0o755);

    for (const [agentName, agentTool] of [
      ["contact-research", "contact-research-agent-tool"],
      ["contact-audit", "contact-audit-agent-tool"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          new URL("./run-contact-research-copilot.mjs", import.meta.url).pathname,
          "test prompt",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
            TEST_COPILOT_ARGS: argsFile,
            CONTACT_RESEARCH_AGENT_NAME: agentName,
            CONTACT_RESEARCH_AGENT_TOOL: agentTool,
          },
        }
      );

      assert.equal(result.status, 0, result.stderr);
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      assert.deepEqual(args.slice(0, 6), [
        "--agent",
        agentName,
        "--model",
        "gpt-6.1-sol",
        "--reasoning-effort",
        "max",
      ]);
      assert.equal(args.filter((arg) => arg === "--model").length, 1);
      assert.ok(args.includes(`--allow-tool=shell(${agentTool})`));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports AIC from OpenTelemetry when JSON checkpoint is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "contact-research-aic-"));
  try {
    const fakeCopilot = join(directory, "copilot");
    const metricsFile = join(directory, "metrics.json");
    const usageFile = join(directory, "usage.jsonl");
    const argsFile = join(directory, "args.json");
    writeFileSync(
      fakeCopilot,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.COPILOT_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
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
          COPILOT_ARGS_FILE: argsFile,
        },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AI credits for Gabatron: 7\.250 AIC/);
    assert.equal(
      JSON.parse(readFileSync(usageFile, "utf8")).nanoAiu,
      7_250_000_000
    );
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.deepEqual(
      args.slice(args.indexOf("--model"), args.indexOf("--model") + 4),
      ["--model", "gpt-6.1-sol", "--reasoning-effort", "max"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
