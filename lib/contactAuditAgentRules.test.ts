import assert from "node:assert/strict";
import test from "node:test";
import {
  contactAuditAutoAppendAlternativeId,
  normalizeContactAuditAgentRules,
} from "./contactAuditAgentRules";

const rosterReview = [
  {
    rosterEntryId: "entry-1",
    assessment: "current",
    notes: "Current regional management contact.",
  },
];

function job(
  overrides: Partial<Parameters<typeof contactAuditAutoAppendAlternativeId>[0][number]> = {},
) {
  return {
    status: "complete",
    finding: "changed",
    confidence: "high",
    claimedAutoAppendAdditionalContact: true,
    rosterReview,
    alternatives: [
      {
        id: "alternative-1",
        normalizedEmail: "new@example.com",
        confidence: "high",
      },
    ],
    ...overrides,
  };
}

test("audit rule text is bounded and normalized", () => {
  assert.equal(
    normalizeContactAuditAgentRules("  Prefer official sources.  "),
    "Prefer official sources.",
  );
  assert.throws(
    () => normalizeContactAuditAgentRules("x".repeat(8001)),
    /8,000 characters or fewer/,
  );
});

test("auto append requires one high-confidence coexisting contact", () => {
  assert.equal(
    contactAuditAutoAppendAlternativeId([job()]),
    "alternative-1",
  );
  assert.equal(
    contactAuditAutoAppendAlternativeId([
      job({
        rosterReview: [
          {
            rosterEntryId: "entry-1",
            assessment: "stale",
            notes: "Stale.",
          },
        ],
      }),
    ]),
    null,
  );
  assert.equal(
    contactAuditAutoAppendAlternativeId([
      job({
        confidence: "medium",
      }),
    ]),
    null,
  );
  assert.equal(
    contactAuditAutoAppendAlternativeId([
      job({
        alternatives: [
          {
            id: "alternative-1",
            normalizedEmail: "new@example.com",
            confidence: "medium",
          },
        ],
      }),
    ]),
    null,
  );
  assert.equal(
    contactAuditAutoAppendAlternativeId([
      job({ claimedAutoAppendAdditionalContact: false }),
    ]),
    null,
  );
});
