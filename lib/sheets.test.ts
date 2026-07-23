import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AuditedContactSheetPostWriteError,
  assertExpectedPreviousSheetTarget,
  captureAuditedContactSheetRollbackCells,
  contactSheetRowDisposition,
  configuredSheetTargetFromValues,
  isSheetSyncLeaseExpired,
  makeSheetConfigurationLeaseKey,
  makeSheetSourceKey,
  makeSheetSyncLeaseKey,
  parseSheetEmails,
  parseSheetSourceKey,
  planAuditedContactSheetCellUpdates,
  planContactSheetCellUpdates,
  reconcileSheetContactSlots,
  remainingLegacySheetAdoptions,
  recoverAuditedContactSheetPostWriteError,
  resolveSheetBootstrapTargetFromValues,
  resolveSheetMutationTarget,
  selectLegacySheetRowAdoption,
  sheetApiRequestOptions,
  sheetDatabaseTransactionTiming,
  sheetSourceKeyBelongsToTarget,
  sheetOwnedContactData,
  shouldKeepApprovedStaleSheetContactQuarantined,
  sheetSyncDeadlineResult,
  staleOwnedSheetContactIds,
  validateSheetBootstrapTarget,
  verifyAuditedContactSheetPostWrite,
} from "./sheets";
import {
  createOperationDeadline,
  OperationDeadlineExceededError,
} from "./integrationUtils";

test("Sheet rows distinguish empty, email, direct outreach, and invalid identities", () => {
  assert.equal(contactSheetRowDisposition("", ""), "empty");
  assert.equal(
    contactSheetRowDisposition("Artist", "contact pending"),
    "direct_outreach"
  );
  assert.equal(
    contactSheetRowDisposition("", "manager@example.com"),
    "invalid_missing_artist"
  );
  assert.equal(
    contactSheetRowDisposition("Artist", ""),
    "invalid_missing_contact"
  );
  assert.equal(
    contactSheetRowDisposition("Artist", "manager@example.com"),
    "email"
  );
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(source, /event: "sheet_contact_row_skipped"/);
  assert.match(source, /"missing_artist"/);
});

test("Sheet ownership reconciliation clears agent direct-outreach provenance", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(source, /CLEAR_AGENT_DIRECT_OUTREACH_PROVENANCE/);
  assert.match(
    source,
    /createRows[\s\S]*sheetOwnedContactData\(plan, now\)/,
  );
  assert.match(
    source,
    /tx\.contact\.update\([\s\S]*sheetOwnedContactData\(plan, now\)/,
  );
});

test("matched agent contacts lose provenance for Sheet email and note ownership", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const row = {
    name: "Sheet Manager",
    role: "management",
    customPrice: null,
    notes: "Sheet-owned notes",
    isFullTeam: false,
  };
  for (const channel of [
    { email: "sheet@example.com", directOutreachNote: null },
    { email: null, directOutreachNote: "Use the Sheet-owned introduction" },
  ]) {
    const data = sheetOwnedContactData(
      {
        artistId: "artist-1",
        sourceKey: "sheet-key",
        row,
        ...channel,
      },
      now,
    );
    assert.equal(data.email, channel.email);
    assert.equal(data.directOutreachNote, channel.directOutreachNote);
    assert.equal(data.source, "sheet");
    assert.equal(data.directOutreachIdentity, null);
    assert.equal(data.directOutreachSourceJobId, null);
    assert.equal(data.directOutreachRuleVersion, null);
    assert.equal(data.directOutreachRuleText, null);
    assert.equal(data.directOutreachManagerName, null);
    assert.equal(data.directOutreachManagerCompany, null);
    assert.deepEqual(data.directOutreachEvidenceUrls, []);
    assert.equal(data.directOutreachEvidence, null);
  }
});

test("same canonical artist and email aliases are deduplicated during Sheet planning", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(source, /event: "sheet_contact_duplicate_skipped"/);
  assert.match(source, /reason: "same_artist_email"/);
  assert.doesNotMatch(source, /Sheet contains duplicate contact/);
});

test("decorated Sheet emails normalize without loosening duplicate identity", () => {
  assert.deepEqual(
    parseSheetEmails(
      "Booking <BOOKING@example.com>, booking@example.com; team@example.com full teams"
    ),
    {
      emails: ["booking@example.com", "team@example.com"],
      isFullTeam: true,
    }
  );
  assert.deepEqual(parseSheetEmails("DM the artist directly"), {
    emails: [],
    isFullTeam: false,
  });

  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /plannedArtistEmails\.has\(artistEmail\)[\s\S]*sheet_contact_duplicate_skipped/,
  );
});

test("Sheet lease keys uniquely encode spreadsheet and tab identity", () => {
  const first = makeSheetSyncLeaseKey("sheet:a", "b");
  const second = makeSheetSyncLeaseKey("sheet", "a:b");

  assert.notEqual(first, second);
  assert.equal(first, makeSheetSyncLeaseKey("sheet:a", "b"));
  assert.notEqual(first, makeSheetSyncLeaseKey("sheet:a", "B"));
});

test("Sheet target configuration has one global lease independent of destination", () => {
  const configurationLease = makeSheetConfigurationLeaseKey();

  assert.equal(configurationLease, makeSheetConfigurationLeaseKey());
  assert.notEqual(
    configurationLease,
    makeSheetSyncLeaseKey("sheet-a", "Artists")
  );
  assert.notEqual(
    configurationLease,
    makeSheetSyncLeaseKey("sheet-b", "Festivals")
  );
});

test("a stale concurrent Sheet switch fails its expected-previous-target compare-and-set", () => {
  const original = { spreadsheetId: "sheet-a", tabName: "Artists" };
  const firstTarget = { spreadsheetId: "sheet-b", tabName: "Artists" };
  const secondTarget = { spreadsheetId: "sheet-c", tabName: "Festivals" };

  assert.doesNotThrow(() =>
    assertExpectedPreviousSheetTarget(original, original)
  );
  const persistedAfterFirstSwitch = firstTarget;
  assert.throws(
    () =>
      assertExpectedPreviousSheetTarget(
        original,
        persistedAfterFirstSwitch
      ),
    /changed after preflight/
  );
  assert.notDeepEqual(persistedAfterFirstSwitch, secondTarget);
});

test("Sheet lease expiry includes the exact expiry instant", () => {
  const expiresAt = new Date("2026-07-16T10:00:00.000Z");
  assert.equal(
    isSheetSyncLeaseExpired(
      expiresAt,
      new Date("2026-07-16T09:59:59.999Z")
    ),
    false
  );
  assert.equal(isSheetSyncLeaseExpired(expiresAt, expiresAt), true);
});

test("custom Sheet tabs round-trip through settings and source identities", () => {
  const tabName = "VIP Artists / East '26";
  const target = {
    spreadsheetId: "sheet-123",
    tabName,
  };
  assert.deepEqual(
    configuredSheetTargetFromValues(" sheet-123 ", ` ${tabName} `),
    target
  );

  const sourceKey = makeSheetSourceKey(target, "row-123", 4);
  assert.deepEqual(parseSheetSourceKey(sourceKey), {
    spreadsheetId: "sheet-123",
    tabName,
    rowId: "row-123",
    slot: 4,
  });
  assert.deepEqual(resolveSheetMutationTarget(target, sourceKey), target);
  assert.throws(
    () =>
      resolveSheetMutationTarget(
        { spreadsheetId: "different-sheet", tabName },
        sourceKey
      ),
    /does not match/
  );
  assert.equal(parseSheetSourceKey("sheet:*:row-123:0"), null);
  assert.equal(
    parseSheetSourceKey(sourceKey.replace(/:4$/, ":04")),
    null
  );
  assert.notEqual(
    sourceKey,
    makeSheetSourceKey(
      { spreadsheetId: "different-sheet", tabName },
      "row-123",
      4
    )
  );
});

test("release bootstrap overrides are complete, authoritative, and deterministic", () => {
  assert.deepEqual(
    resolveSheetBootstrapTargetFromValues(
      " override-sheet ",
      " Release Tab ",
      "database-sheet",
      "Database Tab",
      true
    ),
    {
      target: {
        spreadsheetId: "override-sheet",
        tabName: "Release Tab",
      },
      source: "override",
      configuredTarget: {
        spreadsheetId: "database-sheet",
        tabName: "Database Tab",
      },
      targetChanged: true,
    }
  );
  assert.deepEqual(
    resolveSheetBootstrapTargetFromValues(
      "",
      "",
      "database-sheet",
      "Database Tab"
    ),
    {
      target: {
        spreadsheetId: "database-sheet",
        tabName: "Database Tab",
      },
      source: "database",
      configuredTarget: {
        spreadsheetId: "database-sheet",
        tabName: "Database Tab",
      },
      targetChanged: false,
    }
  );
  assert.throws(
    () =>
      resolveSheetBootstrapTargetFromValues(
        "override-sheet",
        "Release Tab",
        "database-sheet",
        "Database Tab"
      ),
    /SHEETS_TARGET_CHANGE_CONFIRMATION=CONFIRM/
  );
  assert.throws(
    () =>
      resolveSheetBootstrapTargetFromValues(
        "override-sheet",
        "",
        "database-sheet",
        "Database Tab"
      ),
    /settings are incomplete/
  );
});

test("Sheet release preflight reads and validates the authenticated target", async () => {
  const reads: Array<{ spreadsheetId: string; tabName: string }> = [];
  const resolution = await validateSheetBootstrapTarget(
    {
      spreadsheetId: "release-sheet",
      tabName: "Contacts",
      confirmTargetChange: true,
    },
    {
      getConfiguredTarget: async () => ({
        spreadsheetId: "stored-sheet",
        tabName: "Artists",
      }),
      readTargetHeader: async (target) => {
        reads.push(target);
        return ["artist name", "email", "notes"];
      },
    }
  );

  assert.equal(resolution.targetChanged, true);
  assert.deepEqual(reads, [
    { spreadsheetId: "release-sheet", tabName: "Contacts" },
  ]);
  await assert.rejects(
    validateSheetBootstrapTarget(
      {},
      {
        getConfiguredTarget: async () => ({
          spreadsheetId: "stored-sheet",
          tabName: "Artists",
        }),
        readTargetHeader: async () => ["notes"],
      }
    ),
    /requires artist .* and email columns/
  );
});

test("Sheet API timeouts and database transactions consume one deadline", () => {
  let nowMs = 0;
  const deadline = createOperationDeadline(10_000, { now: () => nowMs });
  assert.deepEqual(
    sheetApiRequestOptions(deadline, "Sheet read", 3_000),
    { timeout: 7_000, retry: false }
  );
  assert.deepEqual(
    sheetDatabaseTransactionTiming(
      createOperationDeadline(60_000, { now: () => 0 })
    ),
    {
      maxWait: 10_000,
      timeout: 49_000,
      statementTimeoutMs: 49_000,
    }
  );
  nowMs = 8_000;
  assert.throws(
    () => sheetApiRequestOptions(deadline, "Sheet read", 3_000),
    OperationDeadlineExceededError
  );
  assert.throws(
    () =>
      sheetDatabaseTransactionTiming(
        createOperationDeadline(10_000, { now: () => 0 })
      ),
    OperationDeadlineExceededError
  );
});

test("deadline exhaustion is deferred before writes and partial after writes", () => {
  const error = new OperationDeadlineExceededError(
    "Sheets database reconciliation",
    15_000,
    5_000,
    20_000
  );
  assert.equal(
    sheetSyncDeadlineResult(error, {
      phase: "initial_sheet_read",
      sheetMutationStarted: false,
      databaseMutationStarted: false,
    }).status,
    "deferred"
  );
  const partial = sheetSyncDeadlineResult(error, {
    phase: "stable_row_identity_verification",
    sheetMutationStarted: true,
    databaseMutationStarted: false,
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.details.destructiveWorkStarted, false);
});

test("direct outreach adoption plans one stable row contact and reconciles channel changes", () => {
  const target = { spreadsheetId: "sheet-a", tabName: "Artists" };
  const direct = reconcileSheetContactSlots(target, "row-1", [], {
    emails: [],
    directOutreachNote: "  Reach out through Chase directly  ",
  });
  assert.deepEqual(direct, {
    assignments: [
      {
        sourceKey: makeSheetSourceKey(target, "row-1", 0),
        priorSourceKey: null,
        slot: 0,
        email: null,
        priorEmail: null,
        directOutreachNote: "Reach out through Chase directly",
      },
    ],
    removedSourceKeys: [],
  });

  const first = makeSheetSourceKey(target, "row-1", 0);
  const second = makeSheetSourceKey(target, "row-1", 1);
  const converted = reconcileSheetContactSlots(
    target,
    "row-1",
    [
      { sourceKey: first, slot: 0, email: "first@example.com" },
      { sourceKey: second, slot: 1, email: "second@example.com" },
    ],
    {
      emails: [],
      directOutreachNote: "Personal introduction",
    }
  );
  assert.deepEqual(converted, {
    assignments: [
      {
        sourceKey: first,
        priorSourceKey: first,
        slot: 0,
        email: null,
        priorEmail: "first@example.com",
        directOutreachNote: "Personal introduction",
      },
    ],
    removedSourceKeys: [second],
  });

  const backToEmail = reconcileSheetContactSlots(
    target,
    "row-1",
    [{ sourceKey: first, slot: 0, email: null }],
    {
      emails: ["Booking <BOOKING@example.com>"],
      directOutreachNote: null,
    }
  );
  assert.equal(backToEmail.assignments[0]?.priorSourceKey, first);
  assert.equal(backToEmail.assignments[0]?.email, "booking@example.com");
  assert.equal(backToEmail.assignments[0]?.directOutreachNote, null);
});

test("contact edits plan only changed managed cells and preserve formulas", () => {
  const updates = planContactSheetCellUpdates({
    tabName: "VIP Artists '26",
    sheetRow: 7,
    header: [
      "artist",
      "email",
      "manager_name",
      "status formula",
      "price",
      "notes",
      "photo_admin_id",
    ],
    existing: [
      "Example Artist",
      "old@example.com, team@example.com",
      "Manager",
      '=B7&"-ready"',
      "$400",
      "Keep this",
      "row-123",
    ],
    contactCellValue: "new@example.com, team@example.com",
    managerName: "Manager",
    role: "",
    customPrice: "$500",
    notes: "Keep this",
  });

  assert.deepEqual(
    updates.map(({ columnIndex, range, values }) => ({
      columnIndex,
      range,
      values,
    })),
    [
      {
        columnIndex: 1,
        range: "'VIP Artists ''26'!B7",
        values: [["new@example.com, team@example.com"]],
      },
      {
        columnIndex: 4,
        range: "'VIP Artists ''26'!E7",
        values: [["$500"]],
      },
    ]
  );
  assert.ok(updates.every((update) => update.columnIndex !== 3));
});

test("direct outreach edits target only the managed cell and stay formula-safe", () => {
  const updates = planContactSheetCellUpdates({
    tabName: "Artists",
    sheetRow: 4,
    header: ["artist", "email", "status formula", "photo_admin_id"],
    existing: ["Artist", "Old note", "=B4", "row-1"],
    contactCellValue: "=Reach out personally",
    managerName: "",
    role: "",
    customPrice: "",
    notes: "",
  });

  assert.deepEqual(updates, [
    {
      columnIndex: 1,
      value: "=Reach out personally",
      range: "'Artists'!B4",
      values: [["=Reach out personally"]],
    },
  ]);
});

test("Sheet edits batch precise RAW ranges and read source ids unformatted", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");

  assert.match(source, /valueRenderOption: "UNFORMATTED_VALUE"/);
  assert.match(
    source,
    /data: updates\.map\(\(\{ range, values \}\) => \(\{ range, values \}\)\)/
  );
  assert.match(source, /valueInputOption: "RAW"/);
  assert.doesNotMatch(
    source,
    /spreadsheets\.values\.update\(\{[\s\S]*?requestBody: \{ values: \[updated\] \}/
  );
});

test("legacy Sheet contacts are adopted only for one exact artist identity", () => {
  const contacts = [
    {
      id: "legacy-a",
      source: "sheet",
      sourceKey: null,
      state: "quarantined" as const,
      email: "booking@example.com",
      artist: { id: "artist-a", normalizedName: "same name" },
    },
    {
      id: "manual",
      source: "manual",
      sourceKey: null,
      state: "active" as const,
      email: "booking@example.com",
      artist: { id: "artist-b", normalizedName: "same name" },
    },
  ];

  assert.deepEqual(
    selectLegacySheetRowAdoption(
      "same name",
      ["booking@example.com"],
      contacts
    ),
    {
      kind: "adopt",
      artistId: "artist-a",
      contactIds: ["legacy-a"],
    }
  );

  assert.deepEqual(
    selectLegacySheetRowAdoption("other artist", ["booking@example.com"], contacts),
    { kind: "none" }
  );
});

test("ambiguous legacy contacts remain unowned", () => {
  const adoption = selectLegacySheetRowAdoption(
    "same name",
    ["booking@example.com"],
    [
      {
        id: "legacy-a",
        source: "sheet",
        sourceKey: null,
        state: "quarantined",
        email: "BOOKING@example.com",
        artist: { id: "artist-a", normalizedName: "same name" },
      },
      {
        id: "legacy-b",
        source: "sheet",
        sourceKey: null,
        state: "quarantined",
        email: "booking@example.com",
        artist: { id: "artist-b", normalizedName: "same name" },
      },
    ]
  );

  assert.deepEqual(adoption, {
    kind: "ambiguous",
    artistIds: ["artist-a", "artist-b"],
  });
});

test("only quarantined legacy Sheet contacts are eligible for adoption", () => {
  assert.deepEqual(
    selectLegacySheetRowAdoption(
      "same name",
      ["booking@example.com"],
      [
        {
          id: "active-unowned",
          source: "sheet",
          sourceKey: null,
          state: "active",
          email: "booking@example.com",
          artist: { id: "artist-a", normalizedName: "same name" },
        },
      ]
    ),
    { kind: "none" }
  );
});

test("adoption verification reports remaining adoptable contacts and conflicts", () => {
  const rows = [
    {
      rowId: "row-1",
      artistName: "Same Name",
      emails: ["booking@example.com"],
    },
  ];
  const adoptable = remainingLegacySheetAdoptions(rows, [
    {
      id: "legacy-a",
      source: "sheet",
      sourceKey: null,
      state: "quarantined",
      email: "booking@example.com",
      artist: { id: "artist-a", normalizedName: "same name" },
    },
  ]);
  assert.deepEqual(adoptable, {
    contactIds: ["legacy-a"],
    conflicts: [],
  });

  const conflicted = remainingLegacySheetAdoptions(rows, [
    {
      id: "legacy-a",
      source: "sheet",
      sourceKey: null,
      state: "quarantined",
      email: "booking@example.com",
      artist: { id: "artist-a", normalizedName: "same name" },
    },
    {
      id: "legacy-b",
      source: "sheet",
      sourceKey: null,
      state: "quarantined",
      email: "booking@example.com",
      artist: { id: "artist-b", normalizedName: "same name" },
    },
  ]);
  assert.deepEqual(conflicted, {
    contactIds: [],
    conflicts: [{ rowId: "row-1", artistIds: ["artist-a", "artist-b"] }],
  });
});

test("contact migration is expand-safe and defers quarantine to target reconciliation", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260716080000_contact_quarantine/migration.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(migration, /CREATE TYPE "ContactState"/);
  assert.match(migration, /DEFAULT 'active'/);
  assert.match(migration, /reconciliation atomically adopts matches/);
  assert.doesNotMatch(migration, /UPDATE "Contact"/);
  assert.doesNotMatch(migration, /DELETE FROM "Contact"/);
});

test("direct outreach migration is nullable and leaves existing contacts untouched", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260717160000_contact_direct_outreach_note/migration.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(
    migration,
    /ALTER TABLE "Contact"[\s\S]*ADD COLUMN "directOutreachNote" TEXT/
  );
  assert.doesNotMatch(migration, /NOT NULL|DEFAULT|UPDATE "Contact"/);
});

test("Sheet-owned add and edit flows update the Sheet before the database", () => {
  const addSource = readFileSync(
    new URL(
      "../app/dashboard/add-contact/[artistId]/page.tsx",
      import.meta.url
    ),
    "utf8"
  );
  const addBranch = addSource.indexOf(
    'if (existing?.source === "sheet")'
  );
  const addSheetUpdate = addSource.indexOf(
    "sheetUpdate = await updateContactInSheet",
    addBranch
  );
  const addDatabaseUpdate = addSource.indexOf(
    "await db.contact.update",
    addSheetUpdate
  );
  assert.ok(addBranch >= 0);
  assert.ok(addSheetUpdate > addBranch);
  assert.ok(addDatabaseUpdate > addSheetUpdate);

  const editSource = readFileSync(
    new URL(
      "../app/dashboard/contact/[contactId]/page.tsx",
      import.meta.url
    ),
    "utf8"
  );
  const editSheetUpdate = editSource.indexOf(
    "sheetUpdate = await updateContactInSheet"
  );
  const editDatabaseUpdate = editSource.indexOf(
    "await db.contact.update",
    editSheetUpdate
  );
  assert.ok(editSheetUpdate >= 0);
  assert.ok(editDatabaseUpdate > editSheetUpdate);
  assert.match(editSource, /error: "sheet_sync"/);
  assert.match(editSource, /newDirectOutreachNote: directOutreachNote/);
});

test("stale cleanup scopes ownership to one spreadsheet and tab", () => {
  const target = { spreadsheetId: "sheet-a", tabName: "Artists" };
  const current = makeSheetSourceKey(target, "row-1", 0);
  const otherSpreadsheet = makeSheetSourceKey(
    { spreadsheetId: "sheet-b", tabName: "Artists" },
    "row-2",
    0
  );
  const otherTab = makeSheetSourceKey(
    { spreadsheetId: "sheet-a", tabName: "Festivals" },
    "row-3",
    0
  );
  const legacy = `sheet:${Buffer.from("Artists").toString(
    "base64url"
  )}:row-legacy:0`;

  assert.deepEqual(
    staleOwnedSheetContactIds(
      target,
      false,
      [
        { id: "current", sourceKey: current },
        {
          id: "resolved-quarantine",
          sourceKey: makeSheetSourceKey(target, "row-audit", 0),
          preserveAuditHistory: true,
        },
        { id: "other-spreadsheet", sourceKey: otherSpreadsheet },
        { id: "other-tab", sourceKey: otherTab },
        { id: "legacy", sourceKey: legacy },
        { id: "legacy-unknown", sourceKey: null },
      ],
      new Set(),
      new Set()
    ),
    ["current"]
  );
  assert.equal(sheetSourceKeyBelongsToTarget(legacy, target, true), true);
  assert.deepEqual(parseSheetSourceKey(legacy), {
    spreadsheetId: null,
    tabName: "Artists",
    rowId: "row-legacy",
    slot: 0,
  });
});

test("approved stale Sheet identities stay quarantined until the Sheet target changes", () => {
  const contact = {
    auditJobs: [
      {
        resolution: "approved",
        finding: "stale",
        resolvedEmail: "old.manager@example.com",
        resolvedDirectOutreachNote: null,
      },
    ],
  };
  assert.equal(
    shouldKeepApprovedStaleSheetContactQuarantined(contact, {
      email: "OLD.MANAGER@example.com",
      directOutreachNote: null,
    }),
    true
  );
  for (const finding of ["changed", "ambiguous"]) {
    assert.equal(
      shouldKeepApprovedStaleSheetContactQuarantined(
        {
          auditJobs: [
            {
              resolution: "approved",
              finding,
              resolvedEmail: "new.manager@example.com",
              resolvedDirectOutreachNote: null,
            },
          ],
        },
        {
          email: "new.manager@example.com",
          directOutreachNote: null,
        }
      ),
      false
    );
  }
  assert.equal(
    shouldKeepApprovedStaleSheetContactQuarantined(contact, {
      email: "new.manager@example.com",
      directOutreachNote: null,
    }),
    false
  );
  assert.equal(
    shouldKeepApprovedStaleSheetContactQuarantined(
      {
        auditJobs: [
          {
            resolution: "approved",
            finding: "stale",
            resolvedEmail: null,
            resolvedDirectOutreachNote: "DM the artist",
          },
        ],
      },
      { email: null, directOutreachNote: "DM the artist" }
    ),
    true
  );
  assert.equal(
    shouldKeepApprovedStaleSheetContactQuarantined(
      {
        auditJobs: [],
        auditDecisionMutations: [
          {
            action: "quarantined",
            snapshotEmail: "sheet.manager@example.com",
            snapshotDirectOutreachNote: null,
          },
        ],
      },
      {
        email: "sheet.manager@example.com",
        directOutreachNote: null,
      },
    ),
    true,
  );
  assert.equal(
    shouldKeepApprovedStaleSheetContactQuarantined(
      {
        auditJobs: [],
        auditDecisionMutations: [
          {
            action: "quarantined",
            snapshotEmail: "old.manager@example.com",
            snapshotDirectOutreachNote: null,
          },
        ],
      },
      {
        email: "new.manager@example.com",
        directOutreachNote: null,
      },
    ),
    false,
  );
});

test("audit Sheet updates and rollback capture never touch price or notes", () => {
  const header = [
    "artist",
    "email",
    "manager_name",
    "price",
    "role",
    "notes",
  ];
  const existing = [
    "Artist",
    "old@example.com",
    "Newer Sheet Name",
    "$975",
    "management",
    "Newer Sheet notes",
  ];
  const updates = planAuditedContactSheetCellUpdates({
    tabName: "Artists",
    sheetRow: 2,
    header,
    existing,
    contactCellValue: "new@example.com",
    managerName: "Audited Manager",
    role: "management",
  });

  assert.deepEqual(
    updates.map((update) => update.columnIndex),
    [1, 2]
  );
  assert.deepEqual(
    captureAuditedContactSheetRollbackCells(existing, updates),
    [
      {
        columnIndex: 1,
        before: "old@example.com",
        after: "new@example.com",
      },
      {
        columnIndex: 2,
        before: "Newer Sheet Name",
        after: "Audited Manager",
      },
    ]
  );
  assert.equal(existing[3], "$975");
  assert.equal(existing[5], "Newer Sheet notes");
});

test("post-write audit Sheet failures carry exact rollback state", async () => {
  const rollback = {
    sourceKey: "sheet-source",
    rowId: "row-1",
    cells: [
      {
        columnIndex: 1,
        before: "old@example.com",
        after: "new@example.com",
      },
    ],
  };
  const error = new AuditedContactSheetPostWriteError(
    new Error("lease lost after write"),
    rollback
  );
  await assert.rejects(
    verifyAuditedContactSheetPostWrite(rollback, async () => {
      throw new Error("verification read failed");
    }),
    (failure) => {
      assert.ok(failure instanceof AuditedContactSheetPostWriteError);
      assert.equal(failure.message, "verification read failed");
      assert.deepEqual(failure.rollback, rollback);
      return true;
    }
  );
  await assert.doesNotReject(
    verifyAuditedContactSheetPostWrite(rollback, async () => {})
  );
  let recoveredToken: typeof rollback | null = null;
  assert.deepEqual(
    await recoverAuditedContactSheetPostWriteError(
      error,
      async (token) => {
        recoveredToken = token;
      }
    ),
    { rolledBack: true }
  );
  assert.deepEqual(recoveredToken, rollback);
  assert.deepEqual(
    await recoverAuditedContactSheetPostWriteError(
      error,
      async () => {
        throw new Error("rollback CAS failed");
      }
    ),
    { rolledBack: false, rollbackError: "rollback CAS failed" }
  );

  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /sheetWriteCompleted = true[\s\S]*verifyAuditedContactSheetPostWrite\([\s\S]*auditRollback,[\s\S]*verifyPostWrite/
  );
});

test("Sheet reconciliation honors approved stale audit decisions", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  assert.match(source, /resolution: \{ not: null \}/);
  assert.match(
    source,
    /state: shouldKeepApprovedStaleSheetContactQuarantined/
  );
  assert.match(source, /preserveAuditHistory:/);
  assert.match(
    source,
    /contact\._count\.auditJobs > 0[\s\S]*contact\._count\.auditDecisionMutations > 0/,
  );
  assert.match(source, /auditDecisionMutations:/);
  assert.match(
    source,
    /releasesAuditedIdentity[\s\S]*releasedAuditContactIds\.add/,
  );
  assert.match(
    source,
    /releasedAuditContactIds\.size > 0[\s\S]*data: \{ sourceKey: null \}/,
  );
  assert.match(
    source,
    /!contact\.preserveAuditHistory[\s\S]*staleOwnedSheetContactIds/
  );
  assert.match(
    source,
    /A contact audit decision is currently updating a Sheet-owned contact/
  );
  assert.match(
    source,
    /rollback\.cells\.some\([\s\S]*cell\.after[\s\S]*rollback was not applied/
  );
});

test("Sheet target switches commit only after verified reconciliation", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  const adoptionStart = source.indexOf(
    "export async function adoptConfiguredSheetContacts"
  );
  const reconciliationStart = source.indexOf(
    "const result = await syncContactsAtTarget",
    adoptionStart
  );
  const transactionStart = source.indexOf(
    "return db.$transaction",
    reconciliationStart
  );
  const configurationLease = source.indexOf(
    "return withSheetConfigurationLease",
    reconciliationStart
  );
  const destinationLease = source.indexOf(
    "return withSheetSyncLease",
    configurationLease
  );
  const configurationFence = source.indexOf(
    "await configurationLease.fenceTransaction(tx)",
    transactionStart
  );
  const destinationFence = source.indexOf(
    "await lease.fenceTransaction(tx)",
    configurationFence
  );
  const expectedTargetLock = source.indexOf(
    "await lockExpectedPreviousSheetTarget(tx, configuredTarget)",
    destinationFence
  );
  const firstOwnershipMutation = source.indexOf(
    "const quarantined = await tx.contact.updateMany",
    expectedTargetLock
  );
  const adoptionVerification = source.indexOf(
    "const remainingAdoptions = remainingLegacySheetAdoptions",
    transactionStart
  );
  const priorTargetQuarantine = source.indexOf(
    "let previousTargetQuarantined = 0",
    adoptionVerification
  );
  const targetPersistence = source.indexOf(
    "await compareAndSetSheetTarget(tx, configuredTarget, target)",
    priorTargetQuarantine
  );

  assert.ok(reconciliationStart > adoptionStart);
  assert.doesNotMatch(
    source.slice(adoptionStart, reconciliationStart),
    /setting\.upsert|deleteMany/
  );
  assert.ok(configurationLease > reconciliationStart);
  assert.ok(destinationLease > configurationLease);
  assert.ok(transactionStart > reconciliationStart);
  assert.ok(configurationFence > transactionStart);
  assert.ok(destinationFence > configurationFence);
  assert.ok(expectedTargetLock > destinationFence);
  assert.ok(firstOwnershipMutation > expectedTargetLock);
  assert.ok(adoptionVerification > transactionStart);
  assert.ok(priorTargetQuarantine > adoptionVerification);
  assert.ok(targetPersistence > priorTargetQuarantine);
  assert.match(
    source.slice(priorTargetQuarantine, targetPersistence),
    /sourceKey: plan\.sourceKey,[\s\S]*state: "quarantined"/
  );
});

test("release adoption script fails closed around configured reconciliation", () => {
  const source = readFileSync(
    new URL("../scripts/adopt-sheet-contacts.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /adoptConfiguredSheetContacts/);
  assert.match(source, /SHEETS_SPREADSHEET_ID/);
  assert.match(source, /SHEETS_TAB/);
  assert.match(source, /SHEETS_TARGET_CHANGE_CONFIRMATION/);
  assert.match(source, /--validate-target-only/);
  assert.match(source, /targetReadable: true/);
  assert.match(source, /headerValidated: true/);
  assert.match(source, /process\.exitCode = 1/);
  assert.doesNotMatch(source, /sendOutreach|outreach/);
});

test("Sheet release preflight authenticates and validates spreadsheet structure", () => {
  const source = readFileSync(new URL("./sheets.ts", import.meta.url), "utf8");
  const preflight = source.slice(
    source.indexOf("async function readSheetTargetHeader"),
    source.indexOf("export async function readTab")
  );

  assert.match(preflight, /spreadsheets\.get/);
  assert.match(preflight, /gridProperties\(rowCount,columnCount\)/);
  assert.match(preflight, /spreadsheets\.values\.get/);
  assert.match(preflight, /A1:ZZ1/);
});

test("protected release stages and verifies the exact target before pausing", () => {
  const source = readFileSync(
    new URL(
      "../.github/workflows/release-production.yml",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /vars\.SHEETS_SPREADSHEET_ID/);
  assert.match(source, /secrets\.SHEETS_SPREADSHEET_ID/);
  assert.match(source, /inputs\.sheet_target_change_confirmation/);
  assert.match(source, /--validate-target-only/);
  assert.match(source, /--require-all-migrations/);

  const invariantSteps = [
    "Reject untrusted repository or ref",
    "Check out trusted main without credentials",
    "Validate requested revision against trusted main",
    "Validate production-recovery credentials and project access",
    "Check out previously validated main revision",
    "Verify trusted release checkout",
    "Validate protected environment and recovery target binding",
    "Bind requested SHA to production migration history and verify database connections",
    "Validate Sheet cutover target before staging",
    "Build exact production revision before pausing",
    "Deploy exact target as an unpromoted production artifact",
    "Verify staged exact revision before pausing",
    "Prove staged runtime database and protected settings before pausing",
    "Arm recovery before pausing",
    "Pause production and drain old code",
    "Arm schema cutover recovery",
    "Apply expand-compatible production migrations",
    "Backfill Unicode-normalized artist names",
    "Verify requested migration set and exact-target compatibility",
    "Promote exact deployment",
    "Verify promoted exact deployment",
    "Adopt and verify configured Sheet contacts with new code",
    "Verify new-code ownership and database compatibility",
    "Unpause verified exact target",
  ];
  invariantSteps.reduce((previous, step) => {
    const current = source.indexOf(step);
    assert.ok(current > previous, `${step} must remain ordered`);
    return current;
  }, -1);
  assert.match(source, /ref: refs\/heads\/main/);
  assert.match(source, /persist-credentials: false/);
  assert.match(
    source,
    /ref: \$\{\{ needs\.trust\.outputs\.release_sha \}\}/
  );
  assert.doesNotMatch(source, /ref: \$\{\{ inputs\.revision \}\}/);
  assert.match(source, /confirmation must be exactly RELEASE/);
  assert.match(source, /revision must be an exact commit reachable from trusted main/);
  assert.match(source, /--meta "releaseCommit=\$\{RELEASE_SHA\}"/);
  assert.match(source, /steps\.deploy\.outputs\.url/);
  assert.ok((source.match(/db:verify-targets/g) ?? []).length >= 3);
  assert.match(
    source,
    /bash scripts\/verify-staged-runtime\.sh "\$\{TARGET_URL\}" "\$\{RELEASE_SHA\}"/
  );
  assert.match(source, /sleep 360/);
  assert.doesNotMatch(source, /sleep 1860/);
  assert.match(
    source,
    /id: database-targets[\s\S]*pendingMigrationCount[\s\S]*schema_change_required=true/
  );
  for (const step of [
    "Arm recovery before pausing",
    "Pause production and drain old code",
    "Arm schema cutover recovery",
    "Apply expand-compatible production migrations",
    "Backfill Unicode-normalized artist names",
    "Unpause verified exact target",
  ]) {
    const start = source.indexOf(`      - name: ${step}`);
    assert.ok(start >= 0, `missing conditional migration step ${step}`);
    const end = source.indexOf("\n      - name:", start + 1);
    const body = source.slice(start, end < 0 ? source.length : end);
    assert.match(
      body,
      /if: steps\.database-targets\.outputs\.schema_change_required == 'true'/
    );
  }
  assert.doesNotMatch(source, /\bcall_catch_up\b/);
  for (const route of [
    "/api/cron/sync-shows",
    "/api/cron/sync-listens",
    "/api/cron/contact-research",
    "/api/cron/refresh-top-playlist",
  ]) {
    assert.ok(!source.includes(route), `${route} must not run during release`);
  }
  assert.match(source, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
  assert.doesNotMatch(source, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.doesNotMatch(source, /vercel env pull/);
  assert.doesNotMatch(
    source,
    /Verify protected settings match Vercel production/
  );
  assert.doesNotMatch(
    source,
    /node --env-file=\.vercel\/\.env\.production\.local/
  );
});

test("release requires explicit protected Google credentials for Sheet preflight and adoption", () => {
  const source = readFileSync(
    new URL(
      "../.github/workflows/release-production.yml",
      import.meta.url
    ),
    "utf8"
  );
  const step = (name: string) => {
    const start = source.indexOf(`      - name: ${name}`);
    assert.ok(start >= 0, `missing step ${name}`);
    const end = source.indexOf("\n      - name:", start + 1);
    return source.slice(start, end < 0 ? source.length : end);
  };

  const validation = step(
    "Validate protected environment and recovery target binding"
  );
  const preflight = step("Validate Sheet cutover target before staging");
  const adoption = step(
    "Adopt and verify configured Sheet contacts with new code"
  );

  assert.match(
    validation,
    /GOOGLE_CREDENTIALS_JSON: \$\{\{ secrets\.GOOGLE_CREDENTIALS_JSON \}\}/
  );
  assert.match(validation, /GOOGLE_CREDENTIALS_JSON is required/);
  assert.match(
    validation,
    /JSON\.parse\(process\.env\.GOOGLE_CREDENTIALS_JSON\)/
  );
  for (const sheetStep of [preflight, adoption]) {
    assert.match(
      sheetStep,
      /GOOGLE_CREDENTIALS_JSON: \$\{\{ secrets\.GOOGLE_CREDENTIALS_JSON \}\}/
    );
    assert.match(sheetStep, /-u GOOGLE_CREDENTIALS_PATH/);
    assert.doesNotMatch(sheetStep, /-u GOOGLE_CREDENTIALS_JSON/);
    assert.doesNotMatch(sheetStep, /--env-file/);
  }
});

test("release uses one reviewed job and a main-only recovery environment", () => {
  const source = readFileSync(
    new URL(
      "../.github/workflows/release-production.yml",
      import.meta.url
    ),
    "utf8"
  );
  const releaseJob = source.indexOf("\n  release:");
  const recoveryJob = source.indexOf("\n  recovery:");
  assert.ok(releaseJob > source.indexOf("\n  recovery_preflight:"));
  assert.ok(recoveryJob > source.indexOf("Attempt safe in-job recovery"));
  assert.equal(
    (source.match(/^\s+name: production$/gm) ?? []).length,
    1
  );
  assert.equal(
    (source.match(/^\s+name: production-recovery$/gm) ?? []).length,
    2
  );
  const recoverySource = source.slice(recoveryJob);
  assert.match(recoverySource, /- release/);
  assert.match(recoverySource, /always\(\) &&/);
  assert.match(recoverySource, /github\.ref == 'refs\/heads\/main'/);
  assert.match(recoverySource, /github\.repository == 'zspherez\/photo-admin'/);
  assert.match(
    recoverySource,
    /environment:\s*\n\s+name: production-recovery/
  );
  assert.match(recoverySource, /RECOVERY_VERCEL_TOKEN/);
  assert.match(recoverySource, /ownership_ready == 'true'/);
  assert.match(recoverySource, /RELEASE_OWNERSHIP_READY/);
  assert.match(recoverySource, /verify_deployment\(\)/);
  assert.match(recoverySource, /unpause_project\(\)/);
  assert.doesNotMatch(
    recoverySource,
    /actions\/checkout|recover-production-release\.sh|inputs\./
  );
  assert.doesNotMatch(recoverySource, /^\s+name: production$/m);

  const releaseSource = source.slice(releaseJob, recoveryJob);
  const releaseTailSteps = [
    ...releaseSource.matchAll(/^      - name: (.+)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    releaseTailSteps.slice(-3),
    [
      "Unpause verified exact target",
      "Attempt safe in-job recovery with approved credentials",
      "Remove pulled production settings",
    ],
    "unpause must be the final normal release operation before recovery and cleanup"
  );
  assert.match(releaseSource, /schema_ready/);
  assert.match(releaseSource, /RELEASE_SCHEMA_READY/);
  assert.match(releaseSource, /ownership_ready/);
  assert.match(releaseSource, /RELEASE_OWNERSHIP_READY/);
  assert.match(releaseSource, /recover-production-release\.sh/);
  assert.doesNotMatch(releaseSource, /secrets\.RECOVERY_VERCEL_/);
});
