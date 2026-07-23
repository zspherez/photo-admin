import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContactSnapshot,
  CONTACT_SNAPSHOT_HEADERS,
  contactSnapshotGoogleRows,
  escapeGoogleSheetCell,
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
    snapshot.rows.map((row) => [row[2], row[3], row[5]]),
    [
      ["contact-a", "artist-a", "active"],
      ["contact-b", "artist-a", "quarantined"],
      ["contact-c", "artist-b", "active"],
    ],
  );
  assert.deepEqual(snapshot.rows[0], [
    "2026-07-23T16:25:00.000Z",
    metadata.id,
    "contact-a",
    "artist-a",
    "Alpha",
    "active",
    "Manager",
    "Management",
    "manager@example.com",
    "+1 212 555 0100",
    null,
    false,
    null,
    null,
    "manual",
    null,
    null,
    "2026-07-20T12:00:00.000Z",
    "2026-07-21T12:00:00.000Z",
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
  assert.equal(googleRows[0][6], "'=IMPORTXML(\"https://example.test\")");
  assert.equal(googleRows[0][7], "'+SUM(1,1)");
  assert.equal(googleRows[0][9], "'-1+1");
  assert.equal(googleRows[0][13], "'@command");
  assert.equal(snapshot.rows[0][6], "=IMPORTXML(\"https://example.test\")");
  assert.equal(escapeGoogleSheetCell("safe"), "safe");
  assert.equal(escapeGoogleSheetCell(false), false);
  assert.equal(escapeGoogleSheetCell(null), null);
});
