import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { db } from "./db";
import {
  CONTACT_AUDIT_OIDC_AUDIENCE,
  CONTACT_AUDIT_WORKFLOW_REF,
  buildContactAuditRosterPayload,
  contactStillMatchesAuditSnapshot,
  getTrustedContactAuditOidcEvent,
  isTrustedContactAuditOidcClaims,
  isValidContactAuditAuthorization,
  parseContactAuditClaimLimit,
  parseContactAuditSubmission,
  resolveContactAuditJob,
  validateContactAuditAlternativeEmails,
} from "./contactAudit";

test("parses evidence-backed review-only audit findings", () => {
  const result = parseContactAuditSubmission(
    {
      claimToken: "claim-1",
      finding: "changed",
      sourceUrls: [
        "https://www.instagram.com/drinkurwater/#management",
        "https://www.instagram.com/drinkurwater/",
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
          sourceUrls: ["https://www.instagram.com/drinkurwater/"],
          evidence:
            "DRINKURWATER's official Instagram publishes New.Manager@Agency.example for New Manager.",
          confidence: "high",
        },
      ],
    },
    "old.manager@example.com"
  );

  assert.equal(result.finding, "changed");
  assert.deepEqual(result.sourceUrls, [
    "https://www.instagram.com/drinkurwater/",
  ]);
  assert.equal(result.alternatives[0].email, "new.manager@agency.example");
  assert.equal(result.alternatives[0].role, "management");
});

test("rejects leaked audit payloads while allowing real evidence", () => {
  for (const evidence of [
    "test evidence for save",
    "test no official source",
    "test minimal no official source",
  ]) {
    assert.throws(
      () =>
        parseContactAuditSubmission({
          claimToken: "claim-1",
          finding: "current",
          sourceUrls: ["https://www.instagram.com/drinkurwater/"],
          evidence,
          confidence: "low",
          alternatives: [],
        }),
      /synthetic test or placeholder/
    );
  }
  assert.doesNotThrow(() =>
    parseContactAuditSubmission({
      claimToken: "claim-1",
      finding: "current",
      sourceUrls: ["https://www.instagram.com/drinkurwater/"],
      evidence:
        "The official DRINKURWATER Instagram bio still identifies Justin as management.",
      confidence: "high",
      notes:
        "Test event coverage was reviewed alongside the official artist biography.",
      alternatives: [],
    })
  );
});

test("enforces finding semantics and manager-only alternatives", () => {
  const base = {
    claimToken: "claim-1",
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
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
            sourceUrls: ["https://www.instagram.com/drinkurwater/"],
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
            sourceUrls: ["https://www.instagram.com/drinkurwater/"],
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
    snapshotIsFullTeam: false,
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
    snapshotIsFullTeam: true,
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
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
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
    sourceUrls: ["https://www.instagram.com/drinkurwater/"],
    evidence: "Official management page publishes a genuinely new address.",
    confidence: "high",
    alternatives: [
      {
        email: "new@management.example",
        role: "management",
        sourceUrls: ["https://nuwave.io/team"],
        evidence:
          "The official management team page lists new@management.example as the new address.",
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
    snapshotIsFullTeam: null,
    rosterSnapshot: null,
  });

  assert.equal(roster.completeness, "legacy_single_contact");
  assert.equal(roster.snapshotId, null);
  assert.deepEqual(roster.contacts.map((contact) => contact.isTarget), [true]);
  assert.doesNotThrow(() =>
    parseContactAuditSubmission({
      claimToken: "legacy-claim",
      finding: "current",
      sourceUrls: ["https://www.instagram.com/drinkurwater/"],
      evidence:
        "The official artist profile still identifies the legacy target as current management.",
      confidence: "medium",
      alternatives: [],
    })
  );
});

test("resolution snapshot matching rejects every mutable target-field change and accepts an unchanged target", () => {
  const snapshot = {
    snapshotEmail: "manager@example.com",
    snapshotPhone: "+1 212 555 0100",
    snapshotDirectOutreachNote: "@manager",
    snapshotName: "Manager Name",
    snapshotRole: "management",
    snapshotSource: "sheet",
    snapshotNotes: "Primary manager",
    snapshotIsFullTeam: true,
  };
  const unchanged = {
    state: "active" as const,
    email: "manager@example.com",
    phone: "+1 212 555 0100",
    directOutreachNote: "@manager",
    name: "Manager Name",
    role: "management",
    source: "sheet",
    notes: "Primary manager",
    isFullTeam: true,
  };
  assert.equal(contactStillMatchesAuditSnapshot(snapshot, unchanged), true);

  for (const changed of [
    { state: "quarantined" as const },
    { email: "sheet-sync@example.com" },
    { phone: "+1 646 555 0100" },
    { directOutreachNote: "@sheet-sync-manager" },
    { name: "Sheet Sync Manager" },
    { role: "legacy-role" },
    { source: "manual" },
    { notes: "Changed by Sheet sync" },
    { isFullTeam: false },
  ]) {
    assert.equal(
      contactStillMatchesAuditSnapshot(snapshot, {
        ...unchanged,
        ...changed,
      }),
      false
    );
  }

  assert.equal(
    contactStillMatchesAuditSnapshot(
      { ...snapshot, snapshotIsFullTeam: null },
      { ...unchanged, isFullTeam: false }
    ),
    true,
    "legacy snapshots without a full-team value remain resolvable"
  );
});

test("resolution refuses snapshotted database changes without mutating the target", async () => {
  const mutableDb = db as unknown as {
    $transaction: (
      work: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;
  };
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T16:45:00.000Z");

  try {
    for (const change of [
      { notes: "Changed after audit" },
      { isFullTeam: false },
      { name: "Changed by Sheet sync", source: "sheet" },
    ]) {
    let contactUpdates = 0;
    const contact = {
      id: "contact-1",
      artistId: "artist-1",
      email: "manager@example.com",
      phone: "+1 212 555 0100",
      directOutreachNote: "@manager",
      name: "Manager Name",
      role: "management",
      source: "sheet",
      notes: "Primary manager",
      isFullTeam: true,
      sourceKey: "sheet/tab/row/slot",
      state: "active" as const,
      updatedAt: new Date("2026-07-21T16:30:00.000Z"),
      artist: { name: "Artist" },
      ...change,
    };
    const job = {
      id: "job-1",
      runId: "run-1",
      contactId: contact.id,
      artistId: contact.artistId,
      rosterSnapshotId: "roster-1",
      targetRosterEntryId: "entry-1",
      snapshotArtistName: "Artist",
      snapshotEmail: "manager@example.com",
      snapshotPhone: "+1 212 555 0100",
      snapshotDirectOutreachNote: "@manager",
      snapshotName: "Manager Name",
      snapshotRole: "management",
      snapshotSource: "sheet",
      snapshotNotes: "Primary manager",
      snapshotIsFullTeam: true,
      status: "complete",
      finding: "stale",
      verifiedAt: new Date("2026-07-21T16:35:00.000Z"),
      resolution: null,
      selectedAlternativeId: null,
      resolutionClaimToken: null,
      resolutionClaimedAt: null,
      contact,
    };
    const tx = {
      contactAuditArtistDecision: {
        findUnique: async () => null,
      },
      contactAuditJob: {
        findUnique: async () => job,
        updateMany: async () => ({ count: 0 }),
      },
      contact: {
        update: async () => {
          contactUpdates += 1;
          return contact;
        },
      },
    };
    mutableDb.$transaction = async (work) => work(tx);

    const result = await resolveContactAuditJob(
      job.id,
      "approved",
      null,
      now
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /contact changed after this audit/);
    assert.equal(contactUpdates, 0);
    }
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("resolution succeeds when every snapshotted target field is unchanged", async () => {
  const mutableDb = db as unknown as {
    $transaction: (
      work: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;
  };
  const originalTransaction = mutableDb.$transaction;
  const now = new Date("2026-07-21T16:50:00.000Z");
  const contact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    phone: "+1 212 555 0100",
    directOutreachNote: "@manager",
    name: "Manager Name",
    role: "management",
    source: "manual",
    notes: "Primary manager",
    isFullTeam: true,
    sourceKey: null,
    state: "active" as const,
    updatedAt: new Date("2026-07-21T16:30:00.000Z"),
    artist: { name: "Artist" },
  };
  let resolutionClaimToken: string | null = null;
  let contactUpdates = 0;
  let resolutionSaves = 0;
  const job = {
    id: "job-1",
    runId: "run-1",
    contactId: contact.id,
    artistId: contact.artistId,
    rosterSnapshotId: "roster-1",
    targetRosterEntryId: "entry-1",
    snapshotArtistName: "Artist",
    snapshotEmail: contact.email,
    snapshotPhone: contact.phone,
    snapshotDirectOutreachNote: contact.directOutreachNote,
    snapshotName: contact.name,
    snapshotRole: contact.role,
    snapshotSource: contact.source,
    snapshotNotes: contact.notes,
    snapshotIsFullTeam: contact.isFullTeam,
    status: "complete",
    finding: "stale",
    verifiedAt: new Date("2026-07-21T16:35:00.000Z"),
    resolution: null,
    selectedAlternativeId: null,
    resolutionClaimToken: null as string | null,
    resolutionClaimedAt: null,
    contact,
  };
  const tx = {
    contactAuditArtistDecision: {
      findUnique: async () => null,
    },
    contactAuditJob: {
      findUnique: async () => ({
        ...job,
        resolutionClaimToken,
      }),
      updateMany: async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => {
        if (typeof data.resolutionClaimToken === "string") {
          resolutionClaimToken = data.resolutionClaimToken;
        }
        if (data.resolution === "approved") resolutionSaves += 1;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ resolutionClaimToken }),
    },
    contact: {
      update: async () => {
        contactUpdates += 1;
        return { ...contact, state: "quarantined" as const };
      },
    },
  };
  mutableDb.$transaction = async (work) => work(tx);

  try {
    const result = await resolveContactAuditJob(
      job.id,
      "approved",
      null,
      now
    );
    assert.deepEqual(result, {
      ok: true,
      status: "resolved",
      resolution: "approved",
    });
    assert.equal(contactUpdates, 1);
    assert.equal(resolutionSaves, 1);
  } finally {
    mutableDb.$transaction = originalTransaction;
  }
});

test("finalization rejects a target change that occurs after reservation", async () => {
  const mutableDb = db as unknown as {
    $transaction: (
      work: (tx: Record<string, unknown>) => Promise<unknown>,
      options?: unknown
    ) => Promise<unknown>;
    contactAuditJob: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  };
  const originalTransaction = mutableDb.$transaction;
  const originalUpdateMany = mutableDb.contactAuditJob.updateMany;
  const now = new Date("2026-07-21T16:55:00.000Z");
  let contact = {
    id: "contact-1",
    artistId: "artist-1",
    email: "manager@example.com",
    phone: null,
    directOutreachNote: null,
    name: "Manager Name",
    role: "management",
    source: "manual",
    notes: "Primary manager",
    isFullTeam: true,
    sourceKey: null,
    state: "active" as const,
    updatedAt: new Date("2026-07-21T16:30:00.000Z"),
    artist: { name: "Artist" },
  };
  let resolutionClaimToken: string | null = null;
  let transactionCount = 0;
  let contactUpdates = 0;
  let releasedClaims = 0;
  const job = {
    id: "job-1",
    runId: "run-1",
    contactId: contact.id,
    artistId: contact.artistId,
    rosterSnapshotId: "roster-1",
    targetRosterEntryId: "entry-1",
    snapshotArtistName: "Artist",
    snapshotEmail: contact.email,
    snapshotPhone: contact.phone,
    snapshotDirectOutreachNote: contact.directOutreachNote,
    snapshotName: contact.name,
    snapshotRole: contact.role,
    snapshotSource: contact.source,
    snapshotNotes: contact.notes,
    snapshotIsFullTeam: contact.isFullTeam,
    status: "complete",
    finding: "stale",
    verifiedAt: new Date("2026-07-21T16:35:00.000Z"),
    resolution: null,
    selectedAlternativeId: null,
    resolutionClaimedAt: null,
  };
  const tx = {
    contactAuditArtistDecision: {
      findUnique: async () => null,
    },
    contactAuditJob: {
      findUnique: async () => ({
        ...job,
        resolutionClaimToken,
        contact,
      }),
      updateMany: async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => {
        if (typeof data.resolutionClaimToken === "string") {
          resolutionClaimToken = data.resolutionClaimToken;
        }
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ resolutionClaimToken }),
    },
    contact: {
      update: async () => {
        contactUpdates += 1;
        return contact;
      },
    },
  };
  mutableDb.$transaction = async (work) => {
    transactionCount += 1;
    if (transactionCount === 2) {
      contact = {
        ...contact,
        notes: "Changed after reservation",
        updatedAt: new Date("2026-07-21T16:54:00.000Z"),
      };
    }
    return work(tx);
  };
  mutableDb.contactAuditJob.updateMany = async () => {
    releasedClaims += 1;
    return { count: 1 };
  };

  try {
    const result = await resolveContactAuditJob(
      job.id,
      "approved",
      null,
      now
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /changed while the decision was being applied/);
    assert.equal(contactUpdates, 0);
    assert.equal(releasedClaims, 1);
  } finally {
    mutableDb.$transaction = originalTransaction;
    mutableDb.contactAuditJob.updateMany = originalUpdateMany;
  }
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

test("production audit mutation auth rejects static and cron credentials", async () => {
  const bearer = (token: string) => `Bearer ${token}`;
  const environment = { VERCEL_TARGET_ENV: "production" };
  const rejectOidc = async () => false;
  assert.equal(
    await isValidContactAuditAuthorization(bearer("audit-static"), {
      environment,
      staticToken: "audit-static",
      verifyGithubActionsToken: rejectOidc,
    }),
    false
  );
  assert.equal(
    await isValidContactAuditAuthorization(bearer("cron-secret"), {
      environment,
      staticToken: "cron-secret",
      verifyGithubActionsToken: rejectOidc,
    }),
    false
  );
  assert.equal(
    await isValidContactAuditAuthorization(bearer("audit-oidc"), {
      environment,
      staticToken: "audit-static",
      verifyGithubActionsToken: async (token) => token === "audit-oidc",
    }),
    true
  );
  assert.doesNotMatch(
    readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8"),
    /CRON_SECRET/
  );
});

test("development audit static auth works only when explicitly configured", async () => {
  const bearer = (token: string) => `Bearer ${token}`;
  const environment = { NODE_ENV: "development" };
  const rejectOidc = async () => false;
  assert.equal(
    await isValidContactAuditAuthorization(bearer("local-static"), {
      environment,
      staticToken: "local-static",
      verifyGithubActionsToken: rejectOidc,
    }),
    true
  );
  assert.equal(
    await isValidContactAuditAuthorization(bearer("local-static"), {
      environment,
      verifyGithubActionsToken: rejectOidc,
    }),
    false
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
      aud: "photo-admin-contact-research",
    }),
    false
  );
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

test("only a verified manual audit workflow token can request a full audit", async () => {
  const bearer = (token: string) => `Bearer ${token}`;
  assert.equal(
    await getTrustedContactAuditOidcEvent(
      bearer("manual-token"),
      async (token) =>
        token === "manual-token" ? "workflow_dispatch" : null,
    ),
    "workflow_dispatch",
  );
  assert.equal(
    await getTrustedContactAuditOidcEvent(
      bearer("scheduled-token"),
      async (token) => (token === "scheduled-token" ? "schedule" : null),
    ),
    "schedule",
  );
  assert.equal(
    await getTrustedContactAuditOidcEvent(
      bearer("static-token"),
      async () => null,
    ),
    null,
  );
});

test("contact audit resolution reserves before database finalization and releases failed claims", () => {
  const source = readFileSync(new URL("./contactAudit.ts", import.meta.url), "utf8");
  const resolution = source.slice(
    source.indexOf("export async function resolveContactAuditJob"),
  );
  const reserve = resolution.indexOf("reserveContactAuditResolution(");
  const finalize = resolution.indexOf("finalizeContactAuditResolution(", reserve);
  const release = resolution.indexOf(
    "releaseContactAuditResolutionClaim(",
    finalize
  );

  assert.ok(reserve >= 0);
  assert.ok(finalize > reserve);
  assert.ok(release > finalize);
  assert.doesNotMatch(resolution, /sheet/i);
  assert.match(source, /resolutionClaimToken: reservation\.claimToken/);
  assert.match(
    source,
    /reserveContactAuditResolution[\s\S]*contactAuditResolutionEligibility\(job, now\)/,
  );
  assert.match(
    source,
    /finalizeContactAuditResolution[\s\S]*contactStillMatchesAuditSnapshot\(job, job\.contact\)/,
  );
  const resolutionPolicy = readFileSync(
    new URL("./contactAuditResolutionPolicy.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    resolutionPolicy,
    /contactAuditResolutionEligibility[\s\S]*contactStillMatchesAuditSnapshot\(job, job\.contact\)/,
  );
  assert.match(source, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/);
  assert.match(source, /outreach history will not be merged automatically/);
  assert.match(source, /The database decision could not be saved/);
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
  assert.doesNotMatch(replacement, /source:/);
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

test("legacy per-contact resolution cannot race an artist-level decision", () => {
  const source = readFileSync(
    new URL("./contactAudit.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    (source.match(/contactAuditArtistDecision\.findUnique/g) ?? []).length >=
      2,
  );
  assert.match(
    source,
    /This artist audit was already resolved as one artist-level decision/,
  );
});
