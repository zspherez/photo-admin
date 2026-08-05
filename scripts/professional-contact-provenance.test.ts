import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFetchedSourceRecord,
  claimBoundPrimaryEntityTokens,
  emailAssociation,
  ownershipStatement,
} from "./professional-contact-provenance.mjs";
import { validateProfessionalContactProvenance } from "../lib/professionalContactProvenance.mjs";

test("fetched records preserve evidence URL queries and separate dedupe identity", () => {
  const source = buildFetchedSourceRecord({
    url:
      "https://ledpresents.com/team?canonical=1&utm_source=test#founders",
    title: "LED Presents Team",
    text: "LED Presents Team",
    emails: [],
    links: [],
    blocks: ["LED Presents Team"],
  });
  assert.equal(
    source.url,
    "https://ledpresents.com/team?canonical=1&utm_source=test",
  );
  assert.equal(
    source.identityUrl,
    "https://ledpresents.com/team?canonical=1",
  );
});

test("compact adjacent staff records cannot bind another person's email", () => {
  const source = buildFetchedSourceRecord({
    url: "https://ledpresents.com/team",
    title: "LED Presents Team",
    text:
      "Jane Doe — Founder | John Smith — COO — john.smith@ledpresents.com",
    emails: ["john.smith@ledpresents.com"],
    links: [],
    blocks: [
      "Jane Doe — Founder | John Smith — COO — john.smith@ledpresents.com",
    ],
  });

  assert.equal(
    emailAssociation(source, "john.smith@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
      roleTitle: "Founder",
    }),
    null,
  );
});

test("uppercase and lowercase adjacent people remain distinct identities", () => {
  for (const block of [
    "JANE DOE | Founder | JOHN SMITH | COO | john.smith@ledpresents.com",
    "jane doe | founder | john smith | coo | john.smith@ledpresents.com",
  ]) {
    const source = buildFetchedSourceRecord({
      url: "https://ledpresents.com/team",
      title: "LED Presents Team",
      text: block,
      emails: ["john.smith@ledpresents.com"],
      links: [],
      blocks: [block],
    });

    assert.equal(
      emailAssociation(source, "john.smith@ledpresents.com", {
        personName: "Jane Doe",
        organizationName: "LED Presents",
        roleTitle: "Founder",
      }),
      null,
      block,
    );
  }
});

test("shared surname and shared middle-name records remain distinct", () => {
  for (const [claimedName, block] of [
    [
      "Jane Doe",
      "JANE DOE | Founder | JOHN DOE | COO | john.doe@ledpresents.com",
    ],
    [
      "Jane Ann Doe",
      "jane ann doe | founder | john ann doe | coo | john.doe@ledpresents.com",
    ],
    [
      "Jane Lee",
      "Jane Lee | Founder | John Lee | COO | john.lee@ledpresents.com",
    ],
  ]) {
    const email = block.match(
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    )![0].toLowerCase();
    const source = buildFetchedSourceRecord({
      url: "https://ledpresents.com/team",
      title: "LED Presents Team",
      text: block,
      emails: [email],
      links: [],
      blocks: [block],
    });
    assert.equal(
      emailAssociation(source, email, {
        personName: claimedName,
        organizationName: "LED Presents",
        roleTitle: "Founder",
      }),
      null,
      block,
    );
  }
});

test("separate one-person one-email records produce unambiguous associations", () => {
  const source = buildFetchedSourceRecord({
    url: "https://ledpresents.com/team",
    title: "LED Presents Team",
    text:
      "Jane Doe — Founder — jane.doe@ledpresents.com\nJohn Smith — COO — john.smith@ledpresents.com",
    emails: [
      "jane.doe@ledpresents.com",
      "john.smith@ledpresents.com",
    ],
    links: [],
    blocks: [
      "Jane Doe — Founder — jane.doe@ledpresents.com",
      "John Smith — COO — john.smith@ledpresents.com",
    ],
  });
  assert.ok(
    emailAssociation(source, "jane.doe@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
      roleTitle: "Founder",
    }),
  );
  const ambiguous = buildFetchedSourceRecord({
    url: "https://ledpresents.com/contact",
    title: "LED Presents Contact",
    text:
      "Jane Doe jane.doe@ledpresents.com john.smith@ledpresents.com",
    emails: [
      "jane.doe@ledpresents.com",
      "john.smith@ledpresents.com",
    ],
    links: [],
    blocks: [
      "Jane Doe jane.doe@ledpresents.com john.smith@ledpresents.com",
    ],
  });
  assert.equal(
    emailAssociation(ambiguous, "jane.doe@ledpresents.com", {
      personName: "Jane Doe",
      organizationName: "LED Presents",
      roleTitle: "Founder",
    }),
    null,
  );
});

test("domain links require an explicit contextual ownership statement", () => {
  const linked = buildFetchedSourceRecord({
    url: "https://ledpresents.com/partners",
    title: "LED Presents Partners",
    text: "LED Presents works with agency.com for selected events.",
    emails: [],
    links: [{ label: "Agency", url: "https://agency.com/" }],
    blocks: ["LED Presents works with agency.com for selected events."],
  });
  assert.equal(
    ownershipStatement(linked, "agency.com"),
    null,
  );
  const partner = buildFetchedSourceRecord({
    url: "https://ledpresents.com/partners",
    title: "LED Presents Partners",
    text:
      "LED Presents partners with Agency — Agency official website: agency.com",
    emails: [],
    links: [{ label: "Agency", url: "https://agency.com/" }],
    blocks: [
      "LED Presents partners with Agency — Agency official website: agency.com",
    ],
  });
  assert.deepEqual(
    ownershipStatement(partner, "agency.com")?.entityTokens,
    ["agency"],
  );
  const official = buildFetchedSourceRecord({
    url: "https://ledpresents.com/contact",
    title: "LED Presents Contact",
    text: "LED Presents official email domain: ledmail.com",
    emails: [],
    links: [],
    blocks: ["LED Presents official email domain: ledmail.com"],
  });
  assert.ok(
    ownershipStatement(official, "ledmail.com"),
  );
});

test("authoritative profile identity requires matching slug and primary title", () => {
  const agency = buildFetchedSourceRecord({
    url: "https://www.linkedin.com/company/agency",
    title: "Agency | LinkedIn",
    text: "Agency represents LED Presents. Website: agency.com",
    emails: [],
    links: [{ label: "Website", url: "https://agency.com/" }],
    blocks: ["Agency represents LED Presents. Website: agency.com"],
  });
  assert.deepEqual(agency.primaryEntityTokens, ["agency"]);

  const spoofedSlug = buildFetchedSourceRecord({
    ...agency,
    url: "https://www.linkedin.com/company/led-presents",
    title: "Agency | LinkedIn",
    blocks: ["Agency represents LED Presents. Website: agency.com"],
  });
  assert.deepEqual(spoofedSlug.primaryEntityTokens, [
    "agency",
    "led",
    "presents",
  ]);

  const official = buildFetchedSourceRecord({
    ...agency,
    url: "https://www.linkedin.com/company/led-presents",
    title: "LED Presents | LinkedIn",
    text: "LED Presents Website: ledpresents.com",
    blocks: ["LED Presents Website: ledpresents.com"],
  });
  assert.deepEqual(official.primaryEntityTokens, ["led", "presents"]);

  const extraEntity = buildFetchedSourceRecord({
    ...agency,
    url: "https://www.linkedin.com/company/agency-led-presents",
    title: "Agency LED Presents | LinkedIn",
    text: "Agency LED Presents Website: agency.com",
    blocks: ["Agency LED Presents Website: agency.com"],
  });
  assert.deepEqual(extraEntity.primaryEntityTokens, [
    "agency",
    "led",
    "presents",
  ]);

  const singleCharacterEntity = buildFetchedSourceRecord({
    ...agency,
    url: "https://www.linkedin.com/company/x-led-presents",
    title: "X LED Presents | LinkedIn",
    text: "X LED Presents Website: xledpresents.com",
    blocks: ["X LED Presents Website: xledpresents.com"],
  });
  assert.deepEqual(singleCharacterEntity.primaryEntityTokens, [
    "x",
    "led",
    "presents",
  ]);
});

test("broker preserves extra primary entity tokens through submission validation", () => {
  const claimProvenanceToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const candidate = {
    email: "jane.doe@agency.com",
    personName: "Jane Doe",
    roleTitle: "Founder",
    organization: "LED Presents",
    confidence: "high",
    discoveryMethod: "official",
    sourceUrls: [
      "https://agency.com/team/jane-doe",
      "https://www.linkedin.com/company/agency-led-presents",
    ],
    patternEvidence: null,
    patternEvidenceUrl: null,
    patternExamples: [],
  };
  const agencySource = buildFetchedSourceRecord({
    url: candidate.sourceUrls[0],
    title: "Agency Team",
    text: "Jane Doe | Founder | jane.doe@agency.com",
    emails: [candidate.email],
    links: [],
    blocks: ["Jane Doe | Founder | jane.doe@agency.com"],
  });
  const agencyAssociation = emailAssociation(
    agencySource,
    candidate.email,
    {
      personName: "Jane Doe",
      organizationName: "LED Presents",
      roleTitle: "Founder",
    },
  );
  assert.ok(agencyAssociation);
  const agencyProfile = buildFetchedSourceRecord({
    url: candidate.sourceUrls[1],
    title: "Agency LED Presents | LinkedIn",
    text: "Agency LED Presents Website: agency.com",
    emails: [],
    links: [{ label: "Website", url: "https://agency.com/" }],
    blocks: ["Agency LED Presents Website: agency.com"],
  });
  const agencyOwnership = ownershipStatement(
    agencyProfile,
    "agency.com",
  );
  assert.ok(agencyOwnership);

  const proof = (
    source: ReturnType<typeof buildFetchedSourceRecord>,
    associations: Array<NonNullable<ReturnType<typeof emailAssociation>>>,
    ownership: Array<NonNullable<ReturnType<typeof ownershipStatement>>>,
  ) => ({
    url: source.url,
    contentSha256: source.contentSha256,
    primaryEntityTokens: claimBoundPrimaryEntityTokens(source),
    observedEmails: source.observedEmails,
    observedDomains: source.observedDomains,
    emailAssociations: associations,
    ownershipStatements: ownership,
    contentTokens: source.contentTokens,
  });
  assert.throws(
    () =>
      validateProfessionalContactProvenance(
        { outcome: "candidates", candidates: [candidate] },
        {
          claimProvenanceToken,
          searches: [],
          fetchedSources: [
            proof(agencySource, [agencyAssociation], []),
            proof(agencyProfile, [], [agencyOwnership]),
          ],
        },
        {
          claimProvenanceToken,
          personName: "Jane Doe",
          organizationName: "LED Presents",
          website: null,
        },
      ),
    /domain is not associated/,
  );

  const exactCandidate = {
    ...candidate,
    email: "jane.doe@ledpresents.com",
    sourceUrls: [
      "https://ledpresents.com/team/jane-doe",
      "https://www.linkedin.com/company/led-presents",
    ],
  };
  const exactSource = buildFetchedSourceRecord({
    url: exactCandidate.sourceUrls[0],
    title: "LED Presents Team",
    text: "Jane Doe | Founder | jane.doe@ledpresents.com",
    emails: [exactCandidate.email],
    links: [],
    blocks: ["Jane Doe | Founder | jane.doe@ledpresents.com"],
  });
  const exactAssociation = emailAssociation(
    exactSource,
    exactCandidate.email,
    {
      personName: "Jane Doe",
      organizationName: "LED Presents",
      roleTitle: "Founder",
    },
  );
  assert.ok(exactAssociation);
  const exactProfile = buildFetchedSourceRecord({
    url: exactCandidate.sourceUrls[1],
    title: "LED Presents LLC | LinkedIn",
    text: "LED Presents LLC Website: ledpresents.com",
    emails: [],
    links: [{ label: "Website", url: "https://ledpresents.com/" }],
    blocks: ["LED Presents LLC Website: ledpresents.com"],
  });
  const exactOwnership = ownershipStatement(
    exactProfile,
    "ledpresents.com",
  );
  assert.ok(exactOwnership);
  assert.deepEqual(
    claimBoundPrimaryEntityTokens(exactProfile),
    ["led", "presents", "llc"],
  );
  assert.doesNotThrow(() =>
    validateProfessionalContactProvenance(
      { outcome: "candidates", candidates: [exactCandidate] },
      {
        claimProvenanceToken,
        searches: [],
        fetchedSources: [
          proof(exactSource, [exactAssociation], []),
          proof(exactProfile, [], [exactOwnership]),
        ],
      },
      {
        claimProvenanceToken,
        personName: "Jane Doe",
        organizationName: "LED Presents",
        website: null,
      },
    ),
  );
});
