import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./nav.tsx", import.meta.url), "utf8");

test("primary navigation keeps dashboard shows and manual show sync distinct", () => {
  assert.match(
    source,
    /\{ href: "\/dashboard", label: "Shows", match:/
  );
  assert.match(
    source,
    /\{ href: "\/shows", label: "All shows \/ Sync", match: \(p\) => p === "\/shows" \}/
  );
});
