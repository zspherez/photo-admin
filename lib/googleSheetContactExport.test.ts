import assert from "node:assert/strict";
import test from "node:test";
import type { sheets_v4 } from "googleapis";
import {
  buildContactSnapshot,
  CONTACT_SNAPSHOT_HEADERS,
  contactSnapshotGoogleRows,
  type ContactSnapshotSourceRow,
} from "./contactSnapshot";
import {
  contactSnapshotTabName,
  writeContactSnapshotToGoogleSheet,
} from "./googleSheetContactExport";

function contact(index: number): ContactSnapshotSourceRow {
  return {
    id: `contact-${String(index).padStart(4, "0")}`,
    artistId: "artist-a",
    state: index % 2 === 0 ? "active" : "quarantined",
    name: index === 0 ? "=unsafe" : `Manager ${index}`,
    role: "Management",
    email: `manager-${index}@example.com`,
    phone: null,
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
  };
}

test("Google export creates one tab, writes bounded RAW batches, and verifies", async () => {
  const snapshot = buildContactSnapshot(
    Array.from({ length: 501 }, (_, index) => contact(index)),
    {
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: new Date("2026-07-23T16:25:00.000Z"),
    },
  );
  const updates: Array<Record<string, unknown>> = [];
  const expectedRows = contactSnapshotGoogleRows(snapshot.rows);
  let clearCount = 0;
  let addSheetCount = 0;
  const batchUpdates: Array<Record<string, unknown>> = [];
  const client = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [] } }),
      batchUpdate: async (request: Record<string, unknown>) => {
        addSheetCount++;
        batchUpdates.push(request);
        return {
          data: {
            replies: [{ addSheet: { properties: { sheetId: 321 } } }],
          },
        };
      },
      values: {
        clear: async () => {
          clearCount++;
          return { data: {} };
        },
        update: async (request: Record<string, unknown>) => {
          updates.push(request);
          return { data: {} };
        },
        get: async ({ range }: { range: string }) => {
          if (range.endsWith(":S1")) {
            return { data: { values: [[...CONTACT_SNAPSHOT_HEADERS]] } };
          }
          const match = /!A(\d+):S(\d+)$/.exec(range);
          assert.ok(match);
          const start = Number(match[1]);
          const end = Number(match[2]);
          return {
            data: {
              values: expectedRows.slice(start - 2, end - 1),
            },
          };
        },
      },
    },
  } as unknown as sheets_v4.Sheets;

  const result = await writeContactSnapshotToGoogleSheet(
    snapshot,
    {
      spreadsheetId: "spreadsheet-id",
      sheetTabName: "contacts_2026-07-23_162500_11111111",
    },
    client,
  );

  assert.equal(addSheetCount, 1);
  assert.deepEqual(
    (
      (
        batchUpdates[0].requestBody as {
          requests: Array<{
            addSheet: {
              properties: {
                gridProperties: {
                  rowCount: number;
                  columnCount: number;
                };
              };
            };
          }>;
        }
      ).requests[0].addSheet.properties.gridProperties
    ),
    {
      rowCount: snapshot.contactCount + 1,
      columnCount: CONTACT_SNAPSHOT_HEADERS.length,
    },
  );
  assert.equal(clearCount, 1);
  assert.equal(updates.length, 4);
  assert.ok(
    updates.every((update) => update.valueInputOption === "RAW"),
  );
  const dataBatchSizes = updates.slice(1).map(
    (update) =>
      (
        update.requestBody as {
          values: unknown[][];
        }
      ).values.length,
  );
  assert.deepEqual(dataBatchSizes, [250, 250, 1]);
  const firstDataBatch = updates[1].requestBody as { values: string[][] };
  assert.equal(firstDataBatch.values[0][6], "'=unsafe");
  assert.deepEqual(result, {
    sheetTabId: 321,
    sheetUrl:
      "https://docs.google.com/spreadsheets/d/spreadsheet-id/edit#gid=321",
  });
});

test("retry reuses only the deterministic snapshot tab", async () => {
  let addSheetCount = 0;
  const snapshot = buildContactSnapshot([], {
    id: "22222222-2222-4222-8222-222222222222",
    timestamp: new Date("2026-07-23T16:25:00.000Z"),
  });
  const title = contactSnapshotTabName(snapshot.timestamp, snapshot.id);
  const client = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            {
              properties: {
                title,
                sheetId: 654,
                gridProperties: { rowCount: 1000, columnCount: 26 },
              },
            },
          ],
        },
      }),
      batchUpdate: async () => {
        addSheetCount++;
        return { data: {} };
      },
      values: {
        clear: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
        get: async ({ range }: { range: string }) => {
          if (range.endsWith("!A1:B2")) {
            return {
              data: {
                values: [
                  [
                    CONTACT_SNAPSHOT_HEADERS[0],
                    CONTACT_SNAPSHOT_HEADERS[1],
                  ],
                ],
              },
            };
          }
          return { data: { values: [[...CONTACT_SNAPSHOT_HEADERS]] } };
        },
      },
    },
  } as unknown as sheets_v4.Sheets;

  const result = await writeContactSnapshotToGoogleSheet(
    snapshot,
    { spreadsheetId: "spreadsheet-id", sheetTabName: title },
    client,
  );
  assert.equal(addSheetCount, 0);
  assert.equal(result.sheetTabId, 654);
});

test("verification rejects corrupted snapshot cell content", async () => {
  const snapshot = buildContactSnapshot([contact(0)], {
    id: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date("2026-07-23T16:25:00.000Z"),
  });
  const rows = contactSnapshotGoogleRows(snapshot.rows);
  rows[0][8] = "corrupted@example.com";
  const client = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [] } }),
      batchUpdate: async () => ({
        data: {
          replies: [{ addSheet: { properties: { sheetId: 777 } } }],
        },
      }),
      values: {
        clear: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
        get: async ({ range }: { range: string }) =>
          range.endsWith(":S1")
            ? { data: { values: [[...CONTACT_SNAPSHOT_HEADERS]] } }
            : { data: { values: rows } },
      },
    },
  } as unknown as sheets_v4.Sheets;

  await assert.rejects(
    writeContactSnapshotToGoogleSheet(
      snapshot,
      {
        spreadsheetId: "spreadsheet-id",
        sheetTabName: contactSnapshotTabName(
          snapshot.timestamp,
          snapshot.id,
        ),
      },
      client,
    ),
    /content verification failed/,
  );
});

test("an unrelated existing tab is never cleared or overwritten", async () => {
  const snapshot = buildContactSnapshot([], {
    id: "44444444-4444-4444-8444-444444444444",
    timestamp: new Date("2026-07-23T16:25:00.000Z"),
  });
  const title = contactSnapshotTabName(snapshot.timestamp, snapshot.id);
  let clearCount = 0;
  const client = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            {
              properties: {
                title,
                sheetId: 888,
                gridProperties: { rowCount: 1000, columnCount: 26 },
              },
            },
          ],
        },
      }),
      batchUpdate: async () => ({ data: {} }),
      values: {
        clear: async () => {
          clearCount++;
          return { data: {} };
        },
        update: async () => ({ data: {} }),
        get: async () => ({
          data: { values: [["unrelated", "content"]] },
        }),
      },
    },
  } as unknown as sheets_v4.Sheets;

  await assert.rejects(
    writeContactSnapshotToGoogleSheet(
      snapshot,
      { spreadsheetId: "spreadsheet-id", sheetTabName: title },
      client,
    ),
    /already owned by another export/,
  );
  assert.equal(clearCount, 0);
});
