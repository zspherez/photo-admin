import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  contactResearchPriority,
  CONTACT_RESEARCH_OIDC_AUDIENCE,
  CONTACT_RESEARCH_WORKFLOW_REF,
  isValidContactResearchAuthorization,
  isManagerContact,
  isTrustedContactResearchOidcClaims,
  normalizeManagerRole,
  normalizeContactResearchUserNotes,
  normalizeContactResearchDomain,
  normalizeResearchEmail,
  normalizeResearchSourceUrl,
  parseContactResearchClaimLimit,
  parseKnownContactLookup,
  parseContactResearchSubmission,
  rankKnownContactEmails,
} from "./contactResearch";

test("normalizes research emails and rejects malformed values", () => {
  assert.equal(normalizeResearchEmail(" Manager@Example.COM "), "manager@example.com");
  assert.throws(() => normalizeResearchEmail("not-an-email"), /email is invalid/);
  assert.throws(
    () => normalizeResearchEmail("first,second@example.com"),
    /email is invalid/
  );
  assert.throws(
    () => normalizeResearchEmail("manager@example.com full team"),
    /email is invalid/
  );
});

test("treats every active email as an existing manager contact", () => {
  assert.equal(normalizeManagerRole("manager"), "management");
  assert.equal(normalizeManagerRole("management"), "management");
  assert.throws(() => normalizeManagerRole("booking"), /role must be manager/);
  assert.throws(() => normalizeManagerRole("publicist"), /role must be manager/);
  assert.equal(
    isManagerContact({
      email: "manager@example.com",
      role: "Artist Management",
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "booking@example.com",
      role: "booking agent",
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "legacy@example.com",
      role: null,
    }),
    true
  );
  assert.equal(
    isManagerContact({
      email: "quarantined@example.com",
      role: null,
      state: "quarantined",
    }),
    false
  );
});

test("accepts only public HTTP(S) evidence URLs", () => {
  assert.equal(
    normalizeResearchSourceUrl("https://example.com/contact#team"),
    "https://example.com/contact"
  );
  assert.throws(
    () => normalizeResearchSourceUrl("https://user:pass@example.com"),
    /public HTTP\(S\)/
  );
  assert.throws(
    () => normalizeResearchSourceUrl("file:///tmp/contact"),
    /public HTTP\(S\)/
  );
});

test("normalizes bounded owner research notes", () => {
  assert.equal(
    normalizeContactResearchUserNotes("  Skip this artist  "),
    "Skip this artist"
  );
  assert.equal(normalizeContactResearchUserNotes(""), null);
  assert.throws(
    () => normalizeContactResearchUserNotes("x".repeat(4_001)),
    /research notes must be at most 4000 characters/
  );
});

test("normalizes known-contact company domains", () => {
  assert.equal(
    normalizeContactResearchDomain("Greg@PalmArtists.com"),
    "palmartists.com"
  );
  assert.equal(
    normalizeContactResearchDomain("https://www.palmartists.com/team"),
    "palmartists.com"
  );
  assert.throws(
    () => normalizeContactResearchDomain("localhost"),
    /company domain is invalid/
  );
});

test("ranks a matching manager email above a generic company inbox", () => {
  const rows = rankKnownContactEmails(
    [
      {
        email: "info@palmartists.com",
        name: "Palm Artists",
        evidence: "General management inbox.",
        source: "research_candidate",
        status: "pending",
        artists: ["Sonny Fodera"],
        sourceUrls: ["https://palmartists.com"],
      },
      {
        email: "greg@palmartists.com",
        name: null,
        evidence: null,
        source: "active_contact",
        status: "active",
        artists: ["Gorgon City", "SG Lewis"],
        sourceUrls: [],
      },
    ],
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }
  );

  assert.equal(rows[0].email, "greg@palmartists.com");
  assert.ok(rows[0].score > rows[1].score);
  assert.match(
    rows[0].matchReasons.join(" "),
    /local-part matches manager first name/
  );
});

test("known-contact lookups require a meaningful manager or domain", () => {
  assert.deepEqual(
    parseKnownContactLookup({
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }),
    {
      managerName: "Greg Burnell",
      company: "Palm Artists",
      domain: "palmartists.com",
    }
  );
  assert.throws(
    () => parseKnownContactLookup({ company: "a" }),
    /manager name or company domain is required/
  );
  assert.throws(
    () => parseKnownContactLookup({ managerName: "G" }),
    /manager name must be at least 2 characters/
  );
});

test("parses and deduplicates evidence-backed candidate submissions", () => {
  const submission = parseContactResearchSubmission({
    outcome: "candidates",
    claimToken: "claim-1",
    notes: "Management preferred.",
    candidates: [
      {
        email: "Manager@Example.com",
        name: "Alex Manager",
        role: "management",
        sourceUrls: [
          "https://artist.example/contact",
          "https://artist.example/contact#team",
        ],
        evidence: "The artist's contact page publishes this management email.",
        confidence: "high",
      },
      {
        email: "manager@example.com",
        role: "manager",
        sourceUrls: ["https://agency.example/team"],
        evidence: "Agency team page confirms the same address.",
        confidence: "medium",
      },
    ],
  });

  assert.equal(submission.outcome, "candidates");
  assert.equal(submission.candidates.length, 1);
  assert.equal(submission.candidates[0].normalizedEmail, "manager@example.com");
  assert.deepEqual(submission.candidates[0].sourceUrls, [
    "https://agency.example/team",
  ]);
  assert.equal(submission.candidates[0].role, "management");
});

test("requires evidence and bounded claim limits", () => {
  assert.equal(parseContactResearchClaimLimit(undefined), 3);
  assert.equal(parseContactResearchClaimLimit(10), 10);
  assert.throws(() => parseContactResearchClaimLimit(0), /limit/);
  assert.throws(
    () =>
      parseContactResearchSubmission({
        outcome: "candidates",
        claimToken: "claim-1",
        candidates: [
          {
            email: "manager@example.com",
            role: "management",
            sourceUrls: [],
            evidence: "guess",
            confidence: "low",
          },
        ],
      }),
    /source URL/
  );
});

test("prioritizes interested, matched, popular, and imminent artists", () => {
  const routine = contactResearchPriority({
    interested: false,
    hasActiveSignal: false,
    popularity: 60,
    daysUntilShow: 60,
  });
  const urgent = contactResearchPriority({
    interested: true,
    hasActiveSignal: true,
    popularity: 80,
    daysUntilShow: 5,
  });
  assert.ok(urgent > routine);
});

test("contact research bearer authorization fails closed", async () => {
  assert.equal(
    await isValidContactResearchAuthorization("Bearer correct", "correct"),
    true
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer wrong", "correct"),
    false
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer correct", []),
    false
  );
  assert.equal(
    await isValidContactResearchAuthorization("Bearer cron-secret", [
      "dedicated",
      "cron-secret",
    ]),
    true
  );
  assert.equal(
    await isValidContactResearchAuthorization(
      "Bearer oidc-token",
      [],
      async (token) => token === "oidc-token"
    ),
    true
  );
});

test("GitHub Actions OIDC claims are pinned to the research workflow", () => {
  const trusted = {
    aud: CONTACT_RESEARCH_OIDC_AUDIENCE,
    repository: "zspherez/photo-admin",
    repository_owner: "zspherez",
    ref: "refs/heads/main",
    workflow_ref: CONTACT_RESEARCH_WORKFLOW_REF,
    event_name: "workflow_dispatch",
  };
  assert.equal(isTrustedContactResearchOidcClaims(trusted), true);
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      ref: "refs/heads/untrusted",
    }),
    false
  );
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      workflow_ref:
        "zspherez/photo-admin/.github/workflows/other.yml@refs/heads/main",
    }),
    false
  );
  assert.equal(
    isTrustedContactResearchOidcClaims({
      ...trusted,
      event_name: "pull_request",
    }),
    false
  );
});

test("claims require current eligibility and unexpired ownership", () => {
  const source = readFileSync(
    new URL("./contactResearch.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /claimExpiresAt: \{ gt: now \}/);
  assert.match(source, /show\."syncStatus" = 'active'/);
  assert.match(source, /status: "inactive"/);
  assert.match(source, /job\."requestedShowId" = show\."id"/);
  assert.match(source, /showArtist\.artistId === row\.artistId/);
  assert.doesNotMatch(
    source,
    /COALESCE\(contact\."role"/
  );
  assert.match(
    source,
    /return withSerializableRetry\(async \(tx\) => \{[\s\S]*claimExpiresAt: \{ gt: now \}/
  );
  assert.match(source, /prepareContactResearchQueue/);
  assert.match(source, /claimable/);
  assert.match(source, /researchInstructions: job\.userNotes/);
  assert.match(
    source,
    /retryContactResearchJob[\s\S]*retryEligibleContactResearchJobs/
  );
  assert.match(
    source,
    /retryAllExhaustedContactResearchJobs[\s\S]*retryContactResearchJobsByStatus\("exhausted"\)/
  );
  assert.match(
    source,
    /retryAllReviewContactResearchJobs[\s\S]*retryContactResearchJobsByStatus\("review"\)/
  );
  assert.match(
    source,
    /retryEligibleContactResearchJobs[\s\S]*show\."syncStatus" = 'active'[\s\S]*show\."date" <= \$\{end\}[\s\S]*job\."requestedShowId" = show\."id"/
  );
});
