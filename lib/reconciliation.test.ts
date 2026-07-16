import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  makeSheetSourceKey,
  parseSheetSourceKey,
  reconcileSheetEmailSlots,
} from "./sheets";
import { selectUnambiguousTrackUri } from "./spotify";

test("multi-email edits preserve unchanged slots and reuse the replaced slot", () => {
  const target = { spreadsheetId: "sheet-1", tabName: "Artists" };
  const first = makeSheetSourceKey(target, "row-1", 0);
  const second = makeSheetSourceKey(target, "row-1", 1);
  const result = reconcileSheetEmailSlots(
    target,
    "row-1",
    [
      { sourceKey: first, slot: 0, email: "old@example.com" },
      { sourceKey: second, slot: 1, email: "keep@example.com" },
    ],
    ["new@example.com", "keep@example.com"]
  );
  assert.deepEqual(result.assignments, [
    {
      sourceKey: first,
      priorSourceKey: first,
      slot: 0,
      email: "new@example.com",
      priorEmail: "old@example.com",
    },
    {
      sourceKey: second,
      priorSourceKey: second,
      slot: 1,
      email: "keep@example.com",
      priorEmail: "keep@example.com",
    },
  ]);
  assert.deepEqual(result.removedSourceKeys, []);
  assert.deepEqual(parseSheetSourceKey(first), {
    spreadsheetId: "sheet-1",
    tabName: "Artists",
    rowId: "row-1",
    slot: 0,
  });
});

test("legacy tab-only Sheet ownership migrates to spreadsheet-scoped keys", () => {
  const target = { spreadsheetId: "sheet-1", tabName: "Artists" };
  const legacy = `sheet:${Buffer.from(target.tabName).toString(
    "base64url"
  )}:row-1:0`;
  const result = reconcileSheetEmailSlots(
    target,
    "row-1",
    [{ sourceKey: legacy, slot: 0, email: "booking@example.com" }],
    ["booking@example.com"]
  );

  assert.deepEqual(result.assignments, [
    {
      sourceKey: makeSheetSourceKey(target, "row-1", 0),
      priorSourceKey: legacy,
      slot: 0,
      email: "booking@example.com",
      priorEmail: "booking@example.com",
    },
  ]);
});

test("track search accepts only one exact artist/title result", () => {
  const one = {
    uri: "spotify:track:1",
    name: "Exact Song",
    artists: [{ name: "Exact Artist" }],
  };
  assert.equal(
    selectUnambiguousTrackUri([one], "Exact Song", "Exact Artist"),
    one.uri
  );
  assert.equal(
    selectUnambiguousTrackUri(
      [one, { ...one, uri: "spotify:track:2" }],
      "Exact Song",
      "Exact Artist"
    ),
    null
  );
  assert.equal(
    selectUnambiguousTrackUri([one], "Exact Song", "Different Artist"),
    null
  );
});

test("Spotify integration uses the February 2026 playlist and search APIs", () => {
  const source = readFileSync(
    new URL("./spotify.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const path = "\/me\/playlists"/);
  assert.match(source, /`\/playlists\/\$\{playlistId\}\/items`/);
  assert.match(source, /`\/playlists\/\$\{playlist\.id\}\/items\?/);
  assert.match(source, /limit: "10"/);
  assert.doesNotMatch(source, /\/users\/\$\{userId\}\/playlists/);
  assert.doesNotMatch(source, /\/playlists\/\$\{[^}]+\}\/tracks/);
});
