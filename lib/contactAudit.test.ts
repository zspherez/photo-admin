import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTACT_AUDIT_OIDC_AUDIENCE,
  CONTACT_AUDIT_WORKFLOW_REF,
  buildContactAuditRosterPayload,
  isTrustedContactAuditOidcClaims,
  isValidContactAuditAuthorization,
  parseContactAuditClaimLimit,
  parseContactAuditSubmission,
  validateContactAuditAlternativeEmails,
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

test("Somma-like jobs expose the complete immutable roster with one target and all contact channels", () => {
  const snapshotAt = new Date("2026-07-21T16:30:00.000Z");
  const baseJob = {
    id: "job-email-1",
    contactId: "contact-email-1",
    targetRosterEntryId: "entry-email-1",
    snapshotEmail: "first@management.example",
    snapshotPhone: null,
    snapshotDirectOutreachNote: null,
    snapshotName: "First Manager",
    snapshotRole: "legacy-role",
    snapshotSource: "sheet",
    snapshotNotes: null,
    rosterSnapshot: {
      id: "roster-somma",
      createdAt: snapshotAt,
      entries: [
        {
          id: "entry-email-1",
          snapshotContactId: "contact-email-1",
          snapshotEmail: "first@management.example",
          snapshotPhone: null,
          snapshotDirectOutreachNote: null,
          snapshotName: "First Manager",
          snapshotRole: "legacy-role",
          snapshotSource: "sheet",
          snapshotNotes: null,
          snapshotIsFullTeam: false,
        },
        {
          id: "entry-email-2",
          snapshotContactId: "contact-email-2",
          snapshotEmail: "second@management.example",
          snapshotPhone: "+1 212 555 0100",
          snapshotDirectOutreachNote: "@secondmanager",
          snapshotName: "Second Manager",
          snapshotRole: null,
          snapshotSource: "manual",
          snapshotNotes: "Use the full management team.",
          snapshotIsFullTeam: true,
        },
      ],
    },
  };

  const firstClaim = buildContactAuditRosterPayload(baseJob);
  const secondClaim = buildContactAuditRosterPayload({
    ...baseJob,
    id: "job-email-2",
    contactId: "contact-email-2",
    targetRosterEntryId: "entry-email-2",
    snapshotEmail: "second@management.example",
    snapshotPhone: "+1 212 555 0100",
    snapshotDirectOutreachNote: "@secondmanager",
    snapshotName: "Second Manager",
  });

  assert.equal(firstClaim.completeness, "complete");
  assert.equal(firstClaim.snapshotAt, snapshotAt);
  assert.equal(firstClaim.contacts.length, 2);
  assert.equal(firstClaim.contacts.filter((contact) => contact.isTarget).length, 1);
  assert.equal(secondClaim.contacts.length, 2);
  assert.equal(
    secondClaim.contacts.find((contact) => contact.isTarget)?.email,
    "second@management.example"
  );
  assert.deepEqual(secondClaim.contacts[1], {
    rosterEntryId: "entry-email-2",
    contactId: "contact-email-2",
    isTarget: true,
    email: "second@management.example",
    phone: "+1 212 555 0100",
    directOutreachNote: "@secondmanager",
    name: "Second Manager",
    role: null,
    source: "manual",
    notes: "Use the full management team.",
    isFullTeam: true,
  });

  const laterCurrentContact = {
    email: "changed-later@example.com",
    phone: null,
  };
  assert.equal(laterCurrentContact.email, "changed-later@example.com");
  assert.equal(
    firstClaim.contacts[0].email,
    "first@management.example",
    "claim remains based on the run snapshot"
  );
});

test("complete roster submissions inventory every stored contact and keep stale separate from remaining valid contacts", () => {
  const base = {
    claimToken: "claim-1",
    finding: "stale",
    sourceUrls: ["https://artist.example/management"],
    evidence:
      "The target is stale; second@management.example remains a valid already stored manager.",
    confidence: "high",
    alternatives: [],
  };
  const parsed = parseContactAuditSubmission(
    {
      ...base,
      rosterReview: [
        {
          rosterEntryId: "entry-1",
          assessment: "stale",
          notes: "The target is no longer listed.",
        },
        {
          rosterEntryId: "entry-2",
          assessment: "current",
          notes: "This other stored manager remains valid.",
        },
      ],
    },
    "old@management.example",
    ["entry-1", "entry-2"]
  );
  assert.equal(parsed.finding, "stale");
  assert.equal(parsed.alternatives.length, 0);
  assert.equal(parsed.rosterReview.length, 2);
  const ambiguous = parseContactAuditSubmission(
    {
      ...base,
      finding: "ambiguous",
      evidence:
        "The target and another already stored roster manager both remain plausible.",
      rosterReview: [
        {
          rosterEntryId: "entry-1",
          assessment: "conflicting",
          notes: "The target still appears on one official source.",
        },
        {
          rosterEntryId: "entry-2",
          assessment: "conflicting",
          notes: "This already stored manager appears on another source.",
        },
      ],
    },
    "old@management.example",
    ["entry-1", "entry-2"]
  );
  assert.equal(ambiguous.finding, "ambiguous");
  assert.equal(ambiguous.alternatives.length, 0);
  assert.throws(
    () =>
      parseContactAuditSubmission(
        {
          ...base,
          rosterReview: [
            {
              rosterEntryId: "entry-1",
              assessment: "stale",
              notes: "Only reviewed the target.",
            },
          ],
        },
        "old@management.example",
        ["entry-1", "entry-2"]
      ),
    /inventory every snapshotted artist contact/
  );
});

test("stored roster or current emails are rejected while a genuinely new changed alternative is accepted", () => {
  const changed = parseContactAuditSubmission({
    claimToken: "claim-1",
    finding: "changed",
    sourceUrls: ["https://artist.example/management"],
    evidence: "Official management page publishes a genuinely new address.",
    confidence: "high",
    alternatives: [
      {
        email: "new@management.example",
        role: "management",
        sourceUrls: ["https://management.example/team"],
        evidence: "Official team page lists the new address.",
        confidence: "high",
      },
    ],
    rosterReview: [],
  });
  assert.doesNotThrow(() =>
    validateContactAuditAlternativeEmails(changed.alternatives, [
      "old@management.example",
      "other@management.example",
    ])
  );
  assert.throws(
    () =>
      validateContactAuditAlternativeEmails(changed.alternatives, [
        "NEW@management.example",
      ]),
    /already stored as a contact/
  );
});

test("legacy jobs retain safe explicit single-contact context", () => {
  const roster = buildContactAuditRosterPayload({
    id: "legacy-job",
    contactId: "legacy-contact",
    targetRosterEntryId: null,
    snapshotEmail: "legacy@example.com",
    snapshotPhone: null,
    snapshotDirectOutreachNote: null,
    snapshotName: "Legacy Manager",
    snapshotRole: null,
    snapshotSource: "manual",
    snapshotNotes: null,
    rosterSnapshot: null,
  });
  assert.equal(roster.completeness, "legacy_single_contact");
  assert.equal(roster.snapshotId, null);
  assert.deepEqual(roster.contacts.map((contact) => contact.isTarget), [true]);
  assert.doesNotThrow(() =>
    parseContactAuditSubmission({
      claimToken: "legacy-claim",
      finding: "current",
      sourceUrls: ["https://artist.example/contact"],
      evidence: "The legacy target remains current.",
      confidence: "medium",
      alternatives: [],
    })
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

test("GitHub OIDC trust accepts only scheduled or manual main-branch audit workflow runs", () => {
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
    true
  );
  assert.equal(
    isTrustedContactAuditOidcClaims({
      ...trusted,
      workflow_ref:
        "zspherez/photo-admin/.github/workflows/contact-research.yml@refs/heads/main",
    }),
    false
  );
  assert.equal(
    isTrustedContactAuditOidcClaims({
      ...trusted,
      ref: "refs/heads/feature",
    }),
    false
  );
  assert.equal(
    isTrustedContactAuditOidcClaims({
      ...trusted,
      event_name: "push",
    }),
    false
  );
});

test("contact audit resolution reserves before Sheet work and rolls back failed persistence", () => {
  const source = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const reserve = source.indexOf("reserveContactAuditResolution(");
  const sheetUpdate = source.indexOf(
    "sheetUpdate = await sheetMutations.update(",
    reserve
  );
  const finalize = source.indexOf("finalizeContactAuditResolution(", sheetUpdate);
  const rollback = source.indexOf(
    "await sheetMutations.rollback(sheetUpdate.rollback)",
    finalize
  );

  assert.ok(reserve >= 0);
  assert.ok(sheetUpdate > reserve);
  assert.ok(finalize > sheetUpdate);
  assert.ok(rollback > finalize);
  assert.match(source, /resolutionClaimToken: reservation\.claimToken/);
  assert.match(source, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(source, /outreach history will not be merged automatically/);
  assert.match(source, /Google Sheet update failed; the database and decision were not changed/);
  assert.match(source, /The Sheet change was rolled back/);
  const auditSheetUpdate = source.slice(
    sheetUpdate,
    source.indexOf("} catch (error)", sheetUpdate)
  );
  assert.doesNotMatch(auditSheetUpdate, /customPrice|notes/);
  const postWriteRecovery = source.slice(
    source.indexOf(
      "if (error instanceof AuditedContactSheetPostWriteError)"
    ),
    source.indexOf(
      "await releaseContactAuditResolutionClaim(",
      source.indexOf(
        "if (error instanceof AuditedContactSheetPostWriteError)"
      )
    ) + "await releaseContactAuditResolutionClaim(".length
  );
  assert.match(
    postWriteRecovery,
    /recoverAuditedContactSheetPostWriteError/
  );
  assert.match(source, /Original error: \$\{originalDetail\}/);
  assert.match(source, /Rollback error: \$\{recovery\.rollbackError/);
});

test("reject resolution does not mutate the contact", () => {
  const source = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const finalizer = source.slice(
    source.indexOf("async function finalizeContactAuditResolution"),
    source.indexOf("export async function resolveContactAuditJob")
  );
  assert.match(
    finalizer,
    /if \(decision\.resolution === "approved" && job\.finding === "stale"\)/
  );
  assert.match(
    finalizer,
    /else if \(decision\.resolution === "approved" && alternative\)/
  );
  assert.doesNotMatch(finalizer, /decision\.resolution === "rejected"[\s\S]*tx\.contact\.update/);
});

test("changed and ambiguous replacement atomically clears agent direct-outreach provenance", () => {
  const source = readFileSync(
    new URL("./contactAudit.ts", import.meta.url),
    "utf8",
  );
  const replacement = source.slice(
    source.indexOf(
      'else if (decision.resolution === "approved" && alternative)',
    ),
    source.indexOf("const saved =", source.indexOf(
      'else if (decision.resolution === "approved" && alternative)',
    )),
  );
  assert.match(replacement, /directOutreachNote: null/);
  assert.match(
    replacement,
    /\.\.\.CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE/,
  );
});

test("approved stale and changed decisions mutate only the audited target", () => {
  const source = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const finalizer = source.slice(
    source.indexOf("async function finalizeContactAuditResolution"),
    source.indexOf("export async function resolveContactAuditJob")
  );
  assert.match(
    finalizer,
    /finding === "stale"[\s\S]*tx\.contact\.update\(\{[\s\S]*where: \{ id: job\.contact\.id \}[\s\S]*state: "quarantined"/
  );
  assert.match(
    finalizer,
    /approved" && alternative[\s\S]*tx\.contact\.update\(\{[\s\S]*where: \{ id: job\.contact\.id \}[\s\S]*email: alternative\.normalizedEmail/
  );
  assert.match(finalizer, /contactAuditAlternativeAlreadyStored/);
  assert.doesNotMatch(finalizer, /contact\.updateMany/);
});
