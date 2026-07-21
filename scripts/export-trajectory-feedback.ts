import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import {
  loadTrajectoryEngagementExportRows,
  serializeTrajectoryFeedbackJsonl,
} from "@/lib/trajectoryFeedbackExport";

function parseArguments(args: readonly string[]): { output: string | null } {
  let output: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--output requires a path");
      output = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { output };
}

async function main(): Promise<void> {
  const { output } = parseArguments(process.argv.slice(2));
  const rows = await loadTrajectoryEngagementExportRows();
  const jsonl = serializeTrajectoryFeedbackJsonl(rows);
  if (output) {
    await writeFile(output, jsonl, { encoding: "utf8", flag: "w" });
    console.error(`Exported ${rows.length} trajectory engagement row(s) to ${output}`);
    return;
  }
  process.stdout.write(jsonl);
}

main()
  .catch((error) => {
    console.error(
      "Trajectory feedback export failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
