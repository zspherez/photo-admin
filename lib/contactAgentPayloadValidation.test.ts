import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNonSyntheticText,
  assertPublicHttpsSourceUrl,
  assertSubstantiveCandidateEvidence,
  isObviousSyntheticPlaceholder,
  validateResearchSubmissionPayload,
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

test("candidate identity matching uses exact email and domain tokens", () => {
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official artist page publishes the exact mailbox justin@nuwave.io for management inquiries.",
      "candidate evidence",
      { email: "justin@nuwave.io" }
    )
  );
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official profile at www.nuwave.io identifies the artist's management organization.",
      "candidate evidence",
      { email: "justin@nuwave.io" }
    )
  );
  assert.throws(
    () =>
      assertSubstantiveCandidateEvidence(
        "The unrelated domain notnuwave.io appears in this sufficiently long evidence statement.",
        "candidate evidence",
        { email: "justin@nuwave.io" }
      ),
    /exact candidate email or clearly identify/
  );
  assert.throws(
    () =>
      assertSubstantiveCandidateEvidence(
        "A different mailbox xjustin@nuwave.io.evil appears in this sufficiently long evidence statement.",
        "candidate evidence",
        { email: "justin@nuwave.io" }
      ),
    /exact candidate email or clearly identify/
  );
});

test("candidate name matching is Unicode-aware, boundary-aware, and distinctive", () => {
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official artist biography names Björk Guðmundsdóttir as the submitted representative for this contact.",
      "candidate evidence",
      { name: "Björk Guðmundsdóttir" }
    )
  );
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official management roster identifies José Núñez as the artist's manager and booking representative.",
      "candidate evidence",
      { name: "José Núñez" }
    )
  );
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official roster identifies Justin van der Volgen as the submitted manager for this artist.",
      "candidate evidence",
      { name: "Justin van der Volgen" }
    )
  );
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The official management roster clearly identifies Justin as the artist's submitted manager.",
      "candidate evidence",
      { name: "Justin" }
    )
  );
  for (const [evidence, name] of [
    [
      "The announcement describes a management update but never names the submitted candidate.",
      "Ann",
    ],
    [
      "The official profile describes the management team without identifying a distinctive candidate.",
      "The",
    ],
  ]) {
    assert.throws(
      () =>
        assertSubstantiveCandidateEvidence(
          evidence,
          "candidate evidence",
          { name }
        ),
      /exact candidate email or clearly identify/
    );
  }
});

test("candidate company matching accepts corroborated distinctive company names", () => {
  assert.doesNotThrow(() =>
    assertSubstantiveCandidateEvidence(
      "The artist's official biography identifies Silver Lining Management as the submitted management company.",
      "candidate evidence",
      { company: "Silver Lining Management" }
    )
  );
  assert.doesNotThrow(() =>
    validateResearchSubmissionPayload({
      outcome: "candidates",
      candidates: [
        {
          email: "bookings@gmail.com",
          name: null,
          company: "Silver Lining Management",
          sourceUrls: ["https://artist.example-real.org/management"],
          evidence:
            "The artist's official biography identifies Silver Lining Management as the submitted management company.",
        },
      ],
    })
  );
});
