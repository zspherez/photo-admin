import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTACT_AUDIT_OIDC_AUDIENCE,
  CONTACT_AUDIT_WORKFLOW_REF,
  isTrustedContactAuditOidcClaims,
  isValidContactAuditAuthorization,
  parseContactAuditClaimLimit,
  parseContactAuditSubmission,
} from "./contactAudit";

test("parses evidence-backed review-only audit findings", () => {
  const result = parseContactAuditSubmission(
    {
      claimToken: "claim-1",
      finding: "changed",
      sourceUrls: [
        "https://artist.example/contact#management",
        "https://artist.example/contact",
      ],
      evidence:
        "The current artist page names a different manager and publishes the replacement address.",
      confidence: "high",
      notes: "Checked the official artist and management-company pages.",
      alternatives: [
        {
          email: "New.Manager@Agency.example",
          name: "New Manager",
          role: "manager",
          sourceUrls: ["https://agency.example/team"],
          evidence:
            "The agency roster lists the artist and publishes this manager address.",
          confidence: "high",
        },
      ],
    },
    "old.manager@example.com"
  );

  assert.equal(result.finding, "changed");
  assert.deepEqual(result.sourceUrls, [
    "https://artist.example/contact",
  ]);
  assert.equal(result.alternatives[0].email, "new.manager@agency.example");
  assert.equal(result.alternatives[0].role, "management");
});

test("enforces finding semantics and manager-only alternatives", () => {
  const base = {
    claimToken: "claim-1",
    sourceUrls: ["https://artist.example/contact"],
    evidence: "Bounded public-source review.",
    confidence: "medium",
  };
  assert.throws(
    () =>
      parseContactAuditSubmission({
        ...base,
        finding: "changed",
        alternatives: [],
      }),
    /require an alternative/
  );
  assert.throws(
    () =>
      parseContactAuditSubmission(
        {
          ...base,
          finding: "ambiguous",
          alternatives: [
            {
              email: "same@example.com",
              role: "management",
              sourceUrls: ["https://agency.example"],
              evidence: "Possible manager.",
              confidence: "low",
            },
          ],
        },
        "same@example.com"
      ),
    /differ from the audited email/
  );
  assert.throws(
    () =>
      parseContactAuditSubmission({
        ...base,
        finding: "ambiguous",
        alternatives: [
          {
            email: "booking@example.com",
            role: "booking",
            sourceUrls: ["https://agency.example"],
            evidence: "Booking contact only.",
            confidence: "low",
          },
        ],
      }),
    /role must be manager/
  );
  assert.throws(
    () =>
      parseContactAuditSubmission({
        ...base,
        finding: "current",
        alternatives: [
          {
            email: "other@example.com",
            role: "management",
            sourceUrls: ["https://agency.example"],
            evidence: "Another plausible manager.",
            confidence: "medium",
          },
        ],
      }),
    /use ambiguous/
  );
  assert.throws(
    () =>
      parseContactAuditSubmission({
        ...base,
        finding: "stale",
        alternatives: [
          {
            email: "replacement@example.com",
            role: "management",
            sourceUrls: ["https://agency.example"],
            evidence: "A plausible replacement manager.",
            confidence: "medium",
          },
        ],
      }),
    /stale finding cannot include alternative contacts/
  );
});

test("requires bounded source evidence and claim limits", () => {
  assert.equal(parseContactAuditClaimLimit(undefined), 1);
  assert.equal(parseContactAuditClaimLimit(10), 10);
  assert.throws(() => parseContactAuditClaimLimit(0), /limit/);
  assert.throws(
    () =>
      parseContactAuditSubmission({
        claimToken: "claim-1",
        finding: "unverified",
        sourceUrls: [],
        evidence: "No source.",
        confidence: "low",
        alternatives: [],
      }),
    /source URL/
  );
});

test("contact audit authorization fails closed", async () => {
  const bearer = (token: string) => `Bear${"er "}${token}`;
  assert.equal(
    await isValidContactAuditAuthorization(bearer("correct"), "correct"),
    true
  );
  assert.equal(
    await isValidContactAuditAuthorization(bearer("wrong"), "correct"),
    false
  );
  assert.equal(
    await isValidContactAuditAuthorization(
      bearer("oidc-token"),
      [],
      async (token) => token === "oidc-token"
    ),
    true
  );
});

test("GitHub OIDC trust is pinned to manual audit workflow dispatches", () => {
  const trusted = {
    aud: CONTACT_AUDIT_OIDC_AUDIENCE,
    repository: "zspherez/photo-admin",
    repository_owner: "zspherez",
    ref: "refs/heads/main",
    workflow_ref: CONTACT_AUDIT_WORKFLOW_REF,
    event_name: "workflow_dispatch",
  };
  assert.equal(isTrustedContactAuditOidcClaims(trusted), true);
  assert.equal(
    isTrustedContactAuditOidcClaims({
      ...trusted,
      event_name: "schedule",
    }),
    false
  );
  assert.equal(
    isTrustedContactAuditOidcClaims({
      ...trusted,
      workflow_ref:
        "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main",
    }),
    false
  );
});
