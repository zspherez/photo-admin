import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNamedBusinessEmail,
  validateProfessionalContactProvenance,
} from "./professionalContactProvenance.mjs";

const claimProvenanceToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = {
  claimProvenanceToken,
  personName: "Jane Doe",
  organizationName: "LED Presents",
  website: "https://ledpresents.com/",
};
const directCandidate = {
  email: "jane.doe@ledpresents.com",
  personName: "Jane Doe",
  roleTitle: "Founder",
  organization: "LED Presents",
  confidence: "high",
  discoveryMethod: "official",
  sourceUrls: ["https://ledpresents.com/team/jane-doe"],
  patternEvidence: null,
  patternEvidenceUrl: null,
  patternExamples: [],
};
const directProvenance = {
  claimProvenanceToken,
  searches: [
    {
      query: "\"Jane Doe\" \"LED Presents\"",
      resultUrls: ["https://ledpresents.com/team/jane-doe"],
    },
  ],
  fetchedSources: [
    {
      url: "https://ledpresents.com/team/jane-doe",
      contentSha256: "a".repeat(64),
      observedEmails: ["jane.doe@ledpresents.com"],
      contentTokens: ["jane", "doe", "founder", "led", "presents"],
    },
  ],
};

test("exact published business email passes claim-bound fetched provenance", () => {
  assert.doesNotThrow(() =>
    validateProfessionalContactProvenance(
      { outcome: "candidates", candidates: [directCandidate] },
      directProvenance,
      context,
    ),
  );
});

test("fabricated citations and unsupported exact emails fail closed", () => {
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        {
          outcome: "candidates",
          candidates: [
            {
              ...directCandidate,
              sourceUrls: ["https://ledpresents.com/team/invented"],
            },
          ],
        },
        directProvenance,
        context,
      ),
    /must all be fetched/,
  );
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        { outcome: "candidates", candidates: [directCandidate] },
        {
          ...directProvenance,
          fetchedSources: directProvenance.fetchedSources.map((source) => ({
            ...source,
            observedEmails: [],
          })),
        },
        context,
      ),
    /does not appear in broker-fetched source content/,
  );
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        { outcome: "candidates", candidates: [directCandidate] },
        { ...directProvenance, claimProvenanceToken: crypto.randomUUID() },
        context,
      ),
    /not bound to the current claim/,
  );
});

test("comprehensive public-provider and generic named-person policies reject variants", () => {
  for (const email of [
    "jane@googlemail.com",
    "jane@hotmail.co.uk",
    "jane@yahoo.co.jp",
    "jane@protonmail.ch",
    "jane@mailinator.com",
  ]) {
    assert.throws(
      () => assertNamedBusinessEmail(email),
      /public or disposable email provider/,
      email,
    );
  }
  for (const email of [
    "inquiries@ledpresents.com",
    "contact-us@ledpresents.com",
    "team.nyc@ledpresents.com",
    "hello123@ledpresents.com",
    "founders@ledpresents.com",
  ]) {
    assert.throws(
      () => assertNamedBusinessEmail(email),
      /generic or role inbox/,
      email,
    );
  }
});

test("organization business-domain mismatch is rejected", () => {
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        {
          outcome: "candidates",
          candidates: [
            {
              ...directCandidate,
              email: "jane.doe@unrelated-agency.com",
            },
          ],
        },
        {
          ...directProvenance,
          fetchedSources: directProvenance.fetchedSources.map((source) => ({
            ...source,
            observedEmails: ["jane.doe@unrelated-agency.com"],
          })),
        },
        context,
      ),
    /domain is not associated/,
  );
});

test("low-confidence inference requires fetched published examples with one pattern", () => {
  const patternCandidate = {
    ...directCandidate,
    confidence: "low",
    discoveryMethod: "domain_pattern",
    sourceUrls: ["https://ledpresents.com/team"],
    patternEvidence:
      "The official team page publishes two first.last addresses on the organization domain.",
    patternEvidenceUrl: "https://ledpresents.com/team",
    patternExamples: [
      {
        email: "alex.lee@ledpresents.com",
        personName: "Alex Lee",
      },
      {
        email: "maria.garcia@ledpresents.com",
        personName: "Maria Garcia",
      },
    ],
  };
  const patternProvenance = {
    claimProvenanceToken,
    searches: [],
    fetchedSources: [
      {
        url: "https://ledpresents.com/team",
        contentSha256: "b".repeat(64),
        observedEmails: [
          "alex.lee@ledpresents.com",
          "maria.garcia@ledpresents.com",
        ],
        contentTokens: [
          "alex",
          "lee",
          "maria",
          "garcia",
          "jane",
          "doe",
          "founder",
          "led",
          "presents",
        ],
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateProfessionalContactProvenance(
      { outcome: "candidates", candidates: [patternCandidate] },
      patternProvenance,
      context,
    ),
  );
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        {
          outcome: "candidates",
          candidates: [
            {
              ...patternCandidate,
              email: "jdoe@ledpresents.com",
            },
          ],
        },
        patternProvenance,
        context,
      ),
    /does not follow the published organization email pattern/,
  );
});
