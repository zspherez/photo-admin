import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("freemail remains a native server package so its domain data is traced", () => {
  const source = readFileSync(
    new URL("../next.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /serverExternalPackages: \["freemail"\]/);
});
