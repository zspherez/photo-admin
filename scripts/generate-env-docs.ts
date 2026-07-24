import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderEnvDocs, renderEnvExample } from "@/lib/envDocs";

const ENV_EXAMPLE_PATH = resolve(".env.example");
const ENV_DOCS_PATH = resolve("docs/environment.md");

function parseArguments(): { check: boolean } {
  const args = new Set(process.argv.slice(2));
  const check = args.delete("--check");
  if (args.size > 0) {
    throw new Error(`Unknown argument(s): ${Array.from(args).join(", ")}`);
  }
  return { check };
}

function readExisting(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const { check } = parseArguments();
  const artifacts: { path: string; expected: string }[] = [
    { path: ENV_EXAMPLE_PATH, expected: renderEnvExample() },
    { path: ENV_DOCS_PATH, expected: renderEnvDocs() },
  ];

  if (check) {
    const drifted = artifacts.filter(
      ({ path, expected }) => readExisting(path) !== expected,
    );
    if (drifted.length > 0) {
      console.error(
        `Environment docs are out of date: ${drifted
          .map(({ path }) => path)
          .join(", ")}. Run \`npm run env:generate\`.`,
      );
      process.exit(1);
    }
    console.log("Environment docs are up to date.");
    return;
  }

  for (const { path, expected } of artifacts) {
    writeFileSync(path, expected);
    console.log(`Wrote ${path}`);
  }
}

main();
