import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import {
  loadTrajectoryDecisionExportRows,
  loadTrajectoryEngagementExportRows,
  loadTrajectoryOutcomeExportRows,
  serializeTrajectoryDecisionJsonl,
  serializeTrajectoryEngagementJsonl,
  serializeTrajectoryOutcomeJsonl,
} from "@/lib/trajectoryFeedbackExport";

type ExportKind = "decisions" | "outcomes" | "engagement";

interface ExportArguments {
  kind: ExportKind;
  output: string | null;
  outputDir: string | null;
}

export function parseArguments(args: readonly string[]): ExportArguments {
  let kind: ExportKind = "engagement";
  let kindExplicit = false;
  let output: string | null = null;
  let outputDir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--kind") {
      const value = args[index + 1]?.trim();
      if (
        value !== "decisions" &&
        value !== "outcomes" &&
        value !== "engagement"
      ) {
        throw new Error(
          "--kind must be decisions, outcomes, or engagement",
        );
      }
      kind = value;
      kindExplicit = true;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--output requires a path");
      output = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--output-dir") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("--output-dir requires a path");
      outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (outputDir && (output || kindExplicit)) {
    throw new Error("--output-dir cannot be combined with --kind or --output");
  }
  return { kind, output, outputDir };
}

async function exportOne(kind: ExportKind): Promise<{
  jsonl: string;
  count: number;
}> {
  if (kind === "decisions") {
    const rows = await loadTrajectoryDecisionExportRows();
    return { jsonl: serializeTrajectoryDecisionJsonl(rows), count: rows.length };
  }
  if (kind === "outcomes") {
    const rows = await loadTrajectoryOutcomeExportRows();
    return { jsonl: serializeTrajectoryOutcomeJsonl(rows), count: rows.length };
  }
  const rows = await loadTrajectoryEngagementExportRows();
  return {
    jsonl: serializeTrajectoryEngagementJsonl(rows),
    count: rows.length,
  };
}

async function main(): Promise<void> {
  const { kind, output, outputDir } = parseArguments(process.argv.slice(2));
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const exports = await Promise.all([
      exportOne("decisions"),
      exportOne("outcomes"),
      exportOne("engagement"),
    ]);
    const files = [
      "decisions.jsonl",
      "post_show_outcomes.jsonl",
      "outreach_engagement.jsonl",
    ];
    await Promise.all(
      exports.map((result, index) =>
        writeFile(path.join(outputDir, files[index]), result.jsonl, {
          encoding: "utf8",
          flag: "w",
        }),
      ),
    );
    console.error(
      `Exported ${exports[0].count} decision, ${exports[1].count} outcome, and ${exports[2].count} engagement row(s) to ${outputDir}`,
    );
    return;
  }

  const result = await exportOne(kind);
  if (output) {
    await writeFile(output, result.jsonl, { encoding: "utf8", flag: "w" });
    console.error(`Exported ${result.count} trajectory ${kind} row(s) to ${output}`);
    return;
  }
  process.stdout.write(result.jsonl);
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
