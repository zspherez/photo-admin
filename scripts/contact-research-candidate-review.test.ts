import assert from "node:assert/strict";
import test from "node:test";
import { validateCandidateReview } from "./contact-research-candidate-review.mjs";

const direct = {
  email: "ana@purplewall.com",
  name: "Ana Rohwedder",
  evidence: "Official artist bio lists Ana as management.",
};
const fallback = {
  email: "enamourmgmt@purplewall.com",
  name: "Purple Wall Management",
  evidence: "Official roster publishes the management fallback.",
};
const reviewedEmails = [
  {
    email: direct.email,
    classification: "named_manager",
    personName: "Ana Rohwedder",
    reason: "Named management contact in official artist bio.",
  },
  {
    email: fallback.email,
    classification: "management_fallback",
    personName: null,
    reason: "Artist-specific management inbox.",
  },
  {
    email: "john@analog-a.com",
    classification: "excluded_non_manager",
    personName: "John",
    reason: "Booking agent.",
  },
];

test("requires direct manager email before fallback", () => {
  assert.throws(
    () =>
      validateCandidateReview({
        candidates: [fallback],
        reviewedEmails,
      }),
    /omitted named manager email/
  );
  assert.throws(
    () =>
      validateCandidateReview({
        candidates: [fallback, direct],
        reviewedEmails,
      }),
    /first candidate must be a named manager/
  );
});

test("allows direct manager first and optional fallback second", () => {
  assert.doesNotThrow(() =>
    validateCandidateReview({
      candidates: [direct, fallback],
      reviewedEmails,
    })
  );
  assert.doesNotThrow(() =>
    validateCandidateReview({
      candidates: [direct],
      reviewedEmails,
    })
  );
});

test("rejects excluded or unreviewed candidates", () => {
  assert.throws(
    () =>
      validateCandidateReview({
        candidates: [
          { email: "john@analog-a.com", name: "John", evidence: "Booking" },
        ],
        reviewedEmails,
      }),
    /Excluded non-manager/
  );
  assert.throws(
    () =>
      validateCandidateReview({
        candidates: [
          { email: "other@purplewall.com", name: "Other", evidence: "Other" },
        ],
        reviewedEmails,
      }),
    /missing from reviewedEmails/
  );
});

test("rejects duplicate reviewed-email classifications", () => {
  assert.throws(
    () =>
      validateCandidateReview({
        candidates: [fallback],
        reviewedEmails: [
          {
            email: fallback.email,
            classification: "excluded_non_manager",
            personName: null,
            reason: "Booking.",
          },
          {
            email: fallback.email.toUpperCase(),
            classification: "management_fallback",
            personName: null,
            reason: "Management.",
          },
        ],
      }),
    /reviewedEmails contains duplicate email/
  );
});
