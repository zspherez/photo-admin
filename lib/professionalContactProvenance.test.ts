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
      observedDomains: ["ledpresents.com"],
      emailAssociations: [
        {
          email: "jane.doe@ledpresents.com",
          excerptSha256: "c".repeat(64),
          contentTokens: ["jane", "doe", "founder"],
        },
      ],
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
            emailAssociations: [],
          })),
        },
        context,
      ),
    /not source-locally associated/,
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

test("staff directory email must be locally associated with the claimed person", () => {
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        {
          outcome: "candidates",
          candidates: [
            {
              ...directCandidate,
              email: "john.smith@ledpresents.com",
            },
          ],
        },
        {
          ...directProvenance,
          fetchedSources: [
            {
              ...directProvenance.fetchedSources[0],
              observedEmails: ["john.smith@ledpresents.com"],
              emailAssociations: [
                {
                  email: "john.smith@ledpresents.com",
                  excerptSha256: "d".repeat(64),
                  contentTokens: ["john", "smith", "founder"],
                },
              ],
              contentTokens: [
                "jane",
                "doe",
                "john",
                "smith",
                "founder",
                "led",
                "presents",
              ],
            },
          ],
        },
        context,
      ),
    /not source-locally associated with the claimed person/,
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
    "hr@ledpresents.com",
    "reception@ledpresents.com",
    "operations@ledpresents.com",
    "staff@ledpresents.com",
    "editorial@ledpresents.com",
  ]) {
    assert.throws(
      () => assertNamedBusinessEmail(email),
      /generic or role inbox/,
      email,
    );
  }
});

test("official website controls domain association and can document an alternate", () => {
  const candidate = {
    ...directCandidate,
    email: "jane.doe@ledmail.com",
    sourceUrls: [
      "https://ledpresents.com/contact",
      "https://ledmail.com/team/jane-doe",
    ],
  };
  const provenance = {
    claimProvenanceToken,
    searches: [],
    fetchedSources: [
      {
        url: "https://ledpresents.com/contact",
        contentSha256: "e".repeat(64),
        observedEmails: [],
        observedDomains: ["ledmail.com"],
        emailAssociations: [],
        contentTokens: ["led", "presents", "ledmail"],
      },
      {
        url: "https://ledmail.com/team/jane-doe",
        contentSha256: "f".repeat(64),
        observedEmails: ["jane.doe@ledmail.com"],
        observedDomains: ["ledmail.com"],
        emailAssociations: [
          {
            email: "jane.doe@ledmail.com",
            excerptSha256: "1".repeat(64),
            contentTokens: ["jane", "doe", "founder"],
          },
        ],
        contentTokens: ["jane", "doe", "founder", "led", "presents"],
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateProfessionalContactProvenance(
      { outcome: "candidates", candidates: [candidate] },
      provenance,
      context,
    ),
  );
});

test("without an official website an agency mentioning the organization is insufficient", () => {
  const candidate = {
    ...directCandidate,
    email: "jane.doe@agency.com",
    sourceUrls: [
      "https://agency.com/clients/led-presents",
      "https://agency.com/team/jane-doe",
    ],
  };
  const sources = candidate.sourceUrls.map((url, index) => ({
    url,
    contentSha256: String(index + 2).repeat(64),
    observedEmails:
      index === 1 ? ["jane.doe@agency.com"] : [],
    observedDomains: ["agency.com"],
    emailAssociations:
      index === 1
        ? [
            {
              email: "jane.doe@agency.com",
              excerptSha256: "4".repeat(64),
              contentTokens: ["jane", "doe", "founder"],
            },
          ]
        : [],
    contentTokens: ["led", "presents", "jane", "doe", "founder"],
  }));
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        { outcome: "candidates", candidates: [candidate] },
        {
          claimProvenanceToken,
          searches: [],
          fetchedSources: sources,
        },
        { ...context, website: null },
      ),
    /domain is not associated/,
  );
});

test("without a website two independent matching-domain sources can establish the organization", () => {
  const candidate = {
    ...directCandidate,
    sourceUrls: [
      "https://ledpresents.com/about",
      "https://ledpresents.com/team/jane-doe",
    ],
  };
  const provenance = {
    claimProvenanceToken,
    searches: [],
    fetchedSources: [
      {
        url: "https://ledpresents.com/about",
        contentSha256: "8".repeat(64),
        observedEmails: [],
        observedDomains: ["ledpresents.com"],
        emailAssociations: [],
        contentTokens: ["led", "presents"],
      },
      {
        url: "https://ledpresents.com/team/jane-doe",
        contentSha256: "9".repeat(64),
        observedEmails: ["jane.doe@ledpresents.com"],
        observedDomains: ["ledpresents.com"],
        emailAssociations: [
          {
            email: "jane.doe@ledpresents.com",
            excerptSha256: "a".repeat(64),
            contentTokens: ["jane", "doe", "founder"],
          },
        ],
        contentTokens: ["led", "presents", "jane", "doe", "founder"],
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateProfessionalContactProvenance(
      { outcome: "candidates", candidates: [candidate] },
      provenance,
      { ...context, website: null },
    ),
  );
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
              sourceUrls: [
                "https://unrelated-agency.com/led-presents/jane-doe",
              ],
            },
          ],
        },
        {
          ...directProvenance,
          fetchedSources: directProvenance.fetchedSources.map((source) => ({
            ...source,
            url: "https://unrelated-agency.com/led-presents/jane-doe",
            observedEmails: ["jane.doe@unrelated-agency.com"],
            observedDomains: ["unrelated-agency.com"],
            emailAssociations: [
              {
                email: "jane.doe@unrelated-agency.com",
                excerptSha256: "7".repeat(64),
                contentTokens: ["jane", "doe", "founder"],
              },
            ],
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
        observedDomains: ["ledpresents.com"],
        emailAssociations: [
          {
            email: "alex.lee@ledpresents.com",
            excerptSha256: "5".repeat(64),
            contentTokens: ["alex", "lee"],
          },
          {
            email: "maria.garcia@ledpresents.com",
            excerptSha256: "6".repeat(64),
            contentTokens: ["maria", "garcia"],
          },
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
