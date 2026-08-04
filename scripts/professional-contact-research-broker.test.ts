import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const broker = readFileSync(
  new URL("./professional-contact-research-broker.mjs", import.meta.url),
  "utf8",
);

test("professional contact broker binds fetched provenance to its hidden claim token", () => {
  assert.match(broker, /recordSearch\(state, input\.query, result\)/);
  assert.match(broker, /recordFetch\(state, result\)/);
  assert.match(broker, /contentSha256/);
  assert.match(broker, /observedEmails/);
  assert.match(broker, /emailAssociations/);
  assert.match(broker, /observedDomains/);
  assert.match(broker, /primaryEntityTokens/);
  assert.match(broker, /contentTokens/);
  assert.match(broker, /state\.claim\.provenanceToken/);
  assert.match(broker, /delete publicJob\.provenanceToken/);
  assert.match(broker, /validateProfessionalContactProvenance/);
  assert.match(broker, /provenance,\s*\n\s*}/);
  assert.match(
    broker,
    /error instanceof PhotoAdminRequestError && error\.status === 409/,
  );
  assert.doesNotMatch(
    broker,
    /error\.status === 422[\s\S]*state\.completed = true/,
  );
  assert.match(broker, /typeof data\.code === "string"/);
});
