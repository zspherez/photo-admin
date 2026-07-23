import assert from "node:assert/strict";
import test from "node:test";
import type { sheets_v4 } from "googleapis";
import {
  buildContactSnapshot,
  CONTACT_SNAPSHOT_HEADERS,
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
  let clearCount = 0;
  let addSheetCount = 0;
  const client = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [] } }),
      batchUpdate: async () => {
        addSheetCount++;
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
        get: async ({ range }: { range: string }) =>
          range.endsWith(":S1")
            ? { data: { values: [[...CONTACT_SNAPSHOT_HEADERS]] } }
            : {
                data: {
                  values: Array.from(
                    { length: snapshot.contactCount + 1 },
                    () => ["present"],
                  ),
                },
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
          sheets: [{ properties: { title, sheetId: 654 } }],
        },
      }),
      batchUpdate: async () => {
        addSheetCount++;
        return { data: {} };
      },
      values: {
        clear: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
        get: async ({ range }: { range: string }) =>
          range.endsWith(":S1")
            ? { data: { values: [[...CONTACT_SNAPSHOT_HEADERS]] } }
            : { data: { values: [["snapshot_timestamp"]] } },
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
