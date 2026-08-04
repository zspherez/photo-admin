import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContactEmail } from "./contactEmail";

test("contact emails require one bare normalized mailbox address", () => {
  assert.equal(
    normalizeContactEmail(" Manager@Example.com "),
    "manager@example.com",
  );
  for (const invalid of [
    "talk with asher after ultra",
    "manager@example.com,",
    "manager@example.com;",
    "manager@example.com>",
    "Manager <manager@example.com>",
  ]) {
    assert.equal(normalizeContactEmail(invalid), null);
  }
});
