import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContactSnapshot,
  CONTACT_SNAPSHOT_HEADERS,
  LEGACY_CONTACT_SNAPSHOT_HEADERS,
  contactSnapshotDigest,
  contactSnapshotGoogleRows,
  escapeGoogleSheetCell,
  parseStoredContactSnapshotRows,
  readCanonicalContactRows,
  type ContactSnapshotSourceRow,
} from "./contactSnapshot";

function contact(
  id: string,
  overrides: Partial<ContactSnapshotSourceRow> = {},
): ContactSnapshotSourceRow {
  return {
    id,
    artistId: "artist-a",
    state: "active",
    name: "Manager",
    role: "Management",
    email: "manager@example.com",
    phone: "+1 212 555 0100",
    directOutreachNote: null,
    isFullTeam: false,
    customPrice: null,
    notes: null,
    source: "manual",
    sourceKey: null,
    sourceSyncedAt: null,
    researchConfidence: "high",
    researchEvidence: "Official management page lists this address.",
    researchSourceUrls: ["https://artist.example/management"],
    auditFinding: "valid",
    auditConfidence: "high",
    auditEvidence: "Address remains listed by the artist.",
    auditSourceUrls: ["https://artist.example/contact"],
    auditVerifiedAt: new Date("2026-07-22T12:00:00.000Z"),
    createdAt: new Date("2026-07-20T12:00:00.000Z"),
    updatedAt: new Date("2026-07-21T12:00:00.000Z"),
    artist: {
      id: "artist-a",
      name: "Alpha",
      normalizedName: "alpha",
    },
    ...overrides,
  };
}

const metadata = {
  id: "11111111-1111-4111-8111-111111111111",
  timestamp: new Date("2026-07-23T16:25:00.000Z"),
};

test("contact snapshots contain the documented fields in deterministic order", () => {
  const snapshot = buildContactSnapshot(
    [
      contact("contact-c", {
        artistId: "artist-b",
        artist: {
          id: "artist-b",
          name: "Beta",
          normalizedName: "beta",
        },
      }),
      contact("contact-b", { state: "quarantined" }),
      contact("contact-a"),
    ],
    metadata,
  );

  assert.deepEqual(snapshot.headers, CONTACT_SNAPSHOT_HEADERS);
  assert.deepEqual(
    snapshot.rows.map((row) => [row[11], row[12], row[13]]),
    [
      ["contact-a", "artist-a", "active"],
      ["contact-b", "artist-a", "quarantined"],
      ["contact-c", "artist-b", "active"],
    ],
  );
  assert.deepEqual(snapshot.rows[0], [
    "Alpha",
    "Manager",
    "Management",
    "manager@example.com",
    "+1 212 555 0100",
    null,
    "manual",
    "2026-07-20T12:00:00.000Z",
    "2026-07-21T12:00:00.000Z",
    "2026-07-23T16:25:00.000Z",
    metadata.id,
    "contact-a",
    "artist-a",
    "active",
    null,
    null,
    null,
    null,
    "high",
    "Official management page lists this address.",
    "https://artist.example/management",
    "valid",
    "high",
    "Address remains listed by the artist.",
    "https://artist.example/contact",
    "2026-07-22T12:00:00.000Z",
  ]);
});

test("canonical digest is stable across database return order", () => {
  const rows = [
    contact("contact-b", {
      artistId: "artist-b",
      artist: {
        id: "artist-b",
        name: "Beta",
        normalizedName: "beta",
      },
    }),
    contact("contact-a"),
  ];
  const first = buildContactSnapshot(rows, metadata);
  const second = buildContactSnapshot([...rows].reverse(), metadata);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.match(first.contentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.rows, second.rows);
});

test("versioned snapshot digest covers headers while legacy digest remains rows-only", () => {
  const snapshot = buildContactSnapshot([contact("contact-a")], metadata);
  assert.notEqual(
    contactSnapshotDigest(
      snapshot.rows,
      [...snapshot.headers].reverse(),
      2,
    ),
    snapshot.contentSha256,
  );
  assert.equal(
    contactSnapshotDigest(
      snapshot.rows,
      snapshot.headers,
      1,
    ),
    contactSnapshotDigest(
      snapshot.rows,
      [...snapshot.headers].reverse(),
      1,
    ),
  );
});

test("Google cells neutralize formula prefixes without changing canonical rows", () => {
  const snapshot = buildContactSnapshot(
    [
      contact("contact-a", {
        name: "=IMPORTXML(\"https://example.test\")",
        role: "+SUM(1,1)",
        phone: "-1+1",
        notes: "@command",
      }),
    ],
    metadata,
  );
  const googleRows = contactSnapshotGoogleRows(snapshot.rows);
  assert.equal(googleRows[0][1], "'=IMPORTXML(\"https://example.test\")");
  assert.equal(googleRows[0][2], "'+SUM(1,1)");
  assert.equal(googleRows[0][4], "'-1+1");
  assert.equal(googleRows[0][15], "'@command");
  assert.equal(snapshot.rows[0][1], "=IMPORTXML(\"https://example.test\")");
  assert.equal(escapeGoogleSheetCell("safe"), "safe");
  assert.equal(escapeGoogleSheetCell(false), false);
  assert.equal(escapeGoogleSheetCell(null), null);
});

test("stored legacy snapshot rows keep their original header shape", () => {
  const legacyRow = Array.from(
    { length: LEGACY_CONTACT_SNAPSHOT_HEADERS.length },
    () => null,
  );
  assert.deepEqual(
    parseStoredContactSnapshotRows(
      [legacyRow],
      LEGACY_CONTACT_SNAPSHOT_HEADERS,
    ),
    [legacyRow],
  );
});

test("canonical contact rows include matching research and latest audit evidence", async () => {
  const contactRow = contact("contact-a");
  const rows = await readCanonicalContactRows({
    contact: {
      findMany: async () => [contactRow],
    },
    contactResearchCandidate: {
      findMany: async () => [
        {
          normalizedEmail: "manager@example.com",
          confidence: "high",
          evidence: "Official artist management page.",
          sourceUrls: ["https://artist.example/management"],
          job: { artistId: "artist-a" },
        },
      ],
    },
    $queryRaw: async () => [
      {
        contactId: "contact-a",
        resolvedContactId: null,
        finding: "valid",
        confidence: "high",
        evidence: "Address remains current.",
        sourceUrls: ["https://artist.example/contact"],
        verifiedAt: new Date("2026-07-22T12:00:00.000Z"),
      },
    ],
  } as never);
  assert.deepEqual(rows[0].researchSourceUrls, [
    "https://artist.example/management",
  ]);
  assert.equal(rows[0].researchEvidence, "Official artist management page.");
  assert.equal(rows[0].auditFinding, "valid");
  assert.equal(rows[0].auditEvidence, "Address remains current.");
});
