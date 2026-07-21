import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNonSyntheticText,
  assertPublicHttpsSourceUrl,
  assertSubstantiveCandidateEvidence,
  isObviousSyntheticPlaceholder,
} from "./contactAgentPayloadValidation.mjs";

test("detects obvious placeholders without matching legitimate test prose", () => {
  for (const value of [
    "test evidence for save",
    "test no official source",
    "test minimal no official source",
    "dummy payload",
    "placeholder",
    "example result",
    "probe submission",
    "save test",
  ]) {
    assert.equal(isObviousSyntheticPlaceholder(value), true, value);
  }
  for (const value of [
    "The manager tested the new tour production.",
    "The contest announcement identifies the management company.",
    "Test event coverage names Justin as DRINKURWATER's manager.",
    "Test-event coverage names Justin as DRINKURWATER's manager.",
  ]) {
    assert.equal(isObviousSyntheticPlaceholder(value), false, value);
    assert.doesNotThrow(() => assertNonSyntheticText(value, "evidence"));
  }
});

test("requires real HTTPS public source domains", () => {
  assert.doesNotThrow(() =>
    assertPublicHttpsSourceUrl(
      "https://www.instagram.com/drinkurwater/",
      "source URL"
    )
  );
  for (const value of [
    "http://www.instagram.com/drinkurwater/",
    "https://example.com/contact",
    "https://artist.example.com/contact",
    "https://artist.example/contact",
    "https://source.test/contact",
    "https://localhost/contact",
    "https://127.0.0.1/contact",
  ]) {
    assert.throws(
      () => assertPublicHttpsSourceUrl(value, "source URL"),
      /real public HTTPS URL/
    );
  }
});

test("candidate evidence must be substantive and identify the candidate", () => {
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "DRINKURWATER's official Instagram bio publishes MGMT: justin@nuwave.io.",
      "candidate evidence",
      { email: "justin@nuwave.io", name: "Justin" }
    )
  );
  assert.throws(
    () =>
      assertSubstantiveCandidateEvidence(
        "The official profile publishes a management contact for the artist.",
        "candidate evidence",
        { email: "justin@nuwave.io", name: "Justin" }
      ),
    /exact candidate email or clearly identify/
  );
  assert.throws(
    () =>
      assertSubstantiveCandidateEvidence(
        "Justin manages the artist.",
        "candidate evidence",
        { email: "justin@nuwave.io", name: "Justin" }
      ),
    /must be substantive/
  );
});
