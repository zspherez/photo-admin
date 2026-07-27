import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("artist detail always exposes the artist-scoped add-contact action", () => {
  assert.match(page, /import \{ LinkButton \} from "@\/components\/ui\/button"/);
  assert.match(page, /`\/dashboard\/add-contact\/\$\{artist\.id\}`/);
  assert.match(page, /currentReturnTo/);
  assert.match(page, />\s*Add contact\s*<\/LinkButton>/);
});
