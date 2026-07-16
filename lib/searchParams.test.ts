import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  firstSearchParam,
  positiveIntegerSearchParam,
  validatedTrimmedSearchParam,
} from "./searchParams";

test("repeated search parameters deterministically use the first value", () => {
  assert.equal(firstSearchParam(["first", "second"]), "first");
  assert.equal(
    validatedTrimmedSearchParam(["  Four Tet  ", "Jamie xx"]),
    "Four Tet",
  );
  assert.equal(positiveIntegerSearchParam(["3", "9"]), 3);
});

test("search parameter parsing rejects invalid values without throwing", () => {
  assert.equal(firstSearchParam(undefined), undefined);
  assert.equal(validatedTrimmedSearchParam(["\u0000bad", "safe"]), undefined);
  assert.equal(
    validatedTrimmedSearchParam(["x".repeat(81), "safe"], { maxLength: 80 }),
    undefined,
  );
  assert.equal(positiveIntegerSearchParam(["not-a-page", "2"]), 1);
  assert.equal(positiveIntegerSearchParam(["0", "2"]), 1);
});

test("App Router page props accept repeated search parameters", () => {
  const appRoot = fileURLToPath(new URL("../app/", import.meta.url));
  const pageFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return pageFiles(path);
      return entry.name === "page.tsx" ? [path] : [];
    });

  for (const file of pageFiles(appRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /searchParams:\s*Promise<\{([\s\S]*?)\}>/g,
    )) {
      assert.doesNotMatch(
        match[1],
        /\?:\s*string\b/,
        `${file} must accept string[] values for repeated parameters`,
      );
    }
  }
});
