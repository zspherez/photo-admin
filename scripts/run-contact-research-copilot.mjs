import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  appendUsageRecord,
  creditsFromNanoAiu,
  parseOtelNanoAiu,
  parseUsageEvent,
  readArtistForSession,
} from "./contact-research-usage.mjs";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) throw new Error("A Copilot prompt is required");
const telemetryDirectory = mkdtempSync(
  join(tmpdir(), "contact-research-otel-")
);
const telemetryFile = join(telemetryDirectory, "usage.jsonl");

const child = spawn(
  "copilot",
  [
    "--agent",
    "contact-research",
    "--available-tools=bash",
    "--allow-tool=shell(contact-research-agent-tool)",
    "--secret-env-vars=GITHUB_TOKEN,ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN,CONTACT_RESEARCH_AGENT_TOKEN",
    "--no-ask-user",
    "--no-auto-update",
    "--no-remote",
    "--output-format",
    "json",
    "--stream",
    "off",
    "--prompt",
    prompt,
  ],
  {
    env: {
      ...process.env,
      COPILOT_OTEL_FILE_EXPORTER_PATH: telemetryFile,
    },
    stdio: ["ignore", "pipe", "inherit"],
  }
);

let totalNanoAiu = null;
let resultExitCode = null;
const output = createInterface({ input: child.stdout });
output.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }

  totalNanoAiu = parseUsageEvent(event, totalNanoAiu);
  if (event.type === "tool.execution_start") {
    const summary =
      event.data?.arguments?.description ??
      event.data?.toolName ??
      "tool";
    process.stdout.write(`→ ${summary}\n`);
  }
  if (
    event.type === "tool.execution_complete" &&
    event.data?.success === false
  ) {
    process.stdout.write(
      `Tool failed: ${event.data?.toolName ?? "unknown"}\n`
    );
  }
  if (
    event.type === "assistant.message" &&
    typeof event.data?.content === "string" &&
    event.data.content.trim() &&
    (!Array.isArray(event.data.toolRequests) ||
      event.data.toolRequests.length === 0)
  ) {
    process.stdout.write(`${event.data.content.trim()}\n`);
  }
  if (event.type === "result" && Number.isInteger(event.exitCode)) {
    resultExitCode = event.exitCode;
  }
});

const processExitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 1));
});
const exitCode = resultExitCode ?? processExitCode;
let otelNanoAiu = null;
try {
  otelNanoAiu = parseOtelNanoAiu(
    readFileSync(telemetryFile, "utf8").split(/\r?\n/)
  );
} catch {
  // The JSON event checkpoint remains the fallback for older CLI versions.
}
rmSync(telemetryDirectory, { recursive: true, force: true });
totalNanoAiu = otelNanoAiu ?? totalNanoAiu;
const sessionId = process.env.CONTACT_RESEARCH_AGENT_SESSION ?? "";
const artist = readArtistForSession(
  process.env.CONTACT_RESEARCH_BROKER_METRICS_FILE,
  sessionId
);

if (artist && totalNanoAiu !== null) {
  const credits = creditsFromNanoAiu(totalNanoAiu);
  process.stdout.write(
    `AI credits for ${artist}: ${credits.toFixed(3)} AIC\n`
  );
  const usageFile = process.env.CONTACT_RESEARCH_USAGE_FILE?.trim();
  if (usageFile) {
    appendUsageRecord(usageFile, {
      artist,
      sessionId,
      nanoAiu: totalNanoAiu,
      credits,
      exitCode,
    });
  }
} else if (artist) {
  process.stderr.write(
    `AI credits for ${artist}: unavailable (missing usage checkpoint)\n`
  );
}

process.exitCode = exitCode;
