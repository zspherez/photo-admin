import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./page.tsx", import.meta.url),
  "utf8"
);

test("contacts page is searchable, paginated, and editable", () => {
  assert.match(source, /contact\."state" = 'active'/);
  assert.match(source, /CONTACT_PAGE_SIZE = 100/);
  assert.match(source, /STRPOS\(LOWER\(artist\."name"\), LOWER\(\$\{search\}\)\)/);
  assert.match(source, /name="search"/);
  assert.match(source, /aria-label="Contact pages"/);
  assert.match(source, /withWorkflowReturnTo/);
  assert.match(source, /href="\/settings\/contacts"/);
});
