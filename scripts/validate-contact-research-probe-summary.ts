import { appendFile, readFile } from "node:fs/promises";

import type { CleanupMode } from "@/lib/contactResearchProbeCleanup";
import {
  ContactResearchProbeCleanupSummaryError,
  contactResearchProbeCleanupJobSummary,
  validateContactResearchProbeCleanupAuditSummary,
} from "@/lib/contactResearchProbeCleanupSummary";

function parseArguments(argv: string[]): {
  input: string;
  expectedMode: CleanupMode;
} {
  let input: string | undefined;
  let expectedMode: CleanupMode | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new ContactResearchProbeCleanupSummaryError(
        `${flag ?? "argument"} requires a value`
      );
    }
    if (flag === "--input" && !input) {
      input = value;
    } else if (
      flag === "--expected-mode" &&
      !expectedMode &&
      ["dry-run", "apply", "verify"].includes(value)
    ) {
      expectedMode = value as CleanupMode;
    } else {
      throw new ContactResearchProbeCleanupSummaryError(
        `Unknown or duplicate argument: ${flag}`
      );
    }
  }
  if (!input || !expectedMode) {
    throw new ContactResearchProbeCleanupSummaryError(
      "--input and --expected-mode are required"
    );
  }
  return { input, expectedMode };
}

async function main() {
  const { input, expectedMode } = parseArguments(process.argv.slice(2));
  const summary = validateContactResearchProbeCleanupAuditSummary(
    JSON.parse(await readFile(input, "utf8")) as unknown,
    expectedMode
  );
  const markdown = contactResearchProbeCleanupJobSummary(summary);
  const githubSummary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (githubSummary) {
    await appendFile(githubSummary, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ContactResearchProbeCleanupSummaryError
      ? error.message
      : "Contact research probe cleanup summary validation failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
