import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  contactResearchPriority,
  isValidContactResearchAuthorization,
  isManagerContact,
  normalizeManagerRole,
  normalizeResearchEmail,
  normalizeResearchSourceUrl,
  parseContactResearchClaimLimit,
  parseContactResearchSubmission,
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

test("accepts manager contacts only", () => {
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
    /LOWER\(COALESCE\(contact\."role", ''\)\) LIKE '%manager%'/
  );
  assert.match(
    source,
    /return withSerializableRetry\(async \(tx\) => \{[\s\S]*claimExpiresAt: \{ gt: now \}/
  );
  assert.match(source, /prepareContactResearchQueue/);
  assert.match(source, /claimable/);
});
