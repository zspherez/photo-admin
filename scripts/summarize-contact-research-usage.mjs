import {
  appendFileSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { summarizeUsageRecords } from "./contact-research-usage.mjs";

const root = process.argv[2];
if (!root) throw new Error("Usage artifact directory is required");

function filesUnder(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) =>
    filesUnder(join(path, entry))
  );
}

const records = filesUnder(root)
  .filter((path) => path.endsWith(".jsonl"))
  .flatMap((path) =>
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
const summary = summarizeUsageRecords(records);
const message =
  `Manager research AI credits: ${summary.totalCredits.toFixed(3)} AIC ` +
  `across ${summary.artists} artist(s); average ` +
  `${summary.averageCredits.toFixed(3)} AIC per artist.`;
console.log(message);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Manager research AI-credit usage\n\n${message}\n`
  );
}
