import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("legacy Contacts URLs redirect to the Artists view with filters intact", () => {
  assert.match(source, /redirect\(query \? `\/artists\?\$\{query\}` : "\/artists"\)/);
  assert.match(source, /\["view", "search", "page"\]/);
});
