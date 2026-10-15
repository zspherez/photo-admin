import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  festivalArtistTemplateName,
  festivalArtistsTemplateName,
} from "./festivalArtistTemplateName";

test("festival artist variable uses its unique pairing, or the individual artist", async () => {
  const context = { showId: "show-1", artistId: "artist-1", artistName: "Artist One" };
  assert.equal(
    await festivalArtistTemplateName({
      ...context, isFestival: false,
      readPairings: async () => { throw new Error("Non-festival must not query pairings"); },
    }),
    "Artist One",
  );
  assert.equal(
    await festivalArtistTemplateName({ ...context, isFestival: true, readPairings: async () => [] }),
    "Artist One",
  );
  assert.equal(
    await festivalArtistTemplateName({
      ...context,
      isFestival: true,
      readPairings: async (showId, artistId) => {
        assert.deepEqual([showId, artistId], ["show-1", "artist-1"]);
        return [{ name: "Artist One B2B Artist Two" }];
      },
    }),
    "Artist One B2B Artist Two",
  );
  await assert.rejects(
    festivalArtistTemplateName({
      ...context, isFestival: true,
      readPairings: async () => [{ name: "First pair" }, { name: "Second pair" }],
    }),
    /multiple B2B pairings/,
  );
  await assert.rejects(
    festivalArtistTemplateName({
      ...context, isFestival: true, readPairings: async () => [{ name: "  " }],
    }),
    /pairing name is empty/,
  );
});

test("covered festival artists collapse members of one pairing but preserve different pairings and solo artists", async () => {
  const artists = [
    { artistId: "a", artistName: "A" },
    { artistId: "b", artistName: "B" },
    { artistId: "c", artistName: "C" },
    { artistId: "d", artistName: "D" },
  ];
  const pairings = [
    { id: "ab", name: "A B2B B", members: [{ artistId: "a" }, { artistId: "b" }] },
    { id: "c", name: "C B2B E", members: [{ artistId: "c" }] },
  ];
  assert.equal(
    await festivalArtistsTemplateName({
      showId: "show",
      isFestival: true,
      artists,
      readPairings: async (showId, artistIds) => {
        assert.equal(showId, "show");
        assert.deepEqual(artistIds, ["a", "b", "c", "d"]);
        return pairings;
      },
    }),
    "A B2B B, C B2B E, D",
  );
  assert.equal(
    await festivalArtistsTemplateName({
      showId: "show",
      isFestival: false,
      artists,
      readPairings: async () => { throw new Error("Non-festival should not query pairings"); },
    }),
    "A, B, C, D",
  );
  assert.equal(
    await festivalArtistsTemplateName({
      showId: "show",
      isFestival: true,
      artists: artists.slice(0, 2),
      readPairings: async () => [
        { id: "ab", name: "Same label", members: [{ artistId: "a" }] },
        { id: "bb", name: "Same label", members: [{ artistId: "b" }] },
      ],
    }),
    "Same label, Same label",
  );
  await assert.rejects(
    festivalArtistsTemplateName({
      showId: "show",
      isFestival: true,
      artists,
      readPairings: async () => [
        ...pairings,
        { id: "other", name: "Other pairing", members: [{ artistId: "a" }] },
      ],
    }),
    /multiple B2B pairings/,
  );
});

test("original, follow-up, and Customize use pairing names only for template variables", () => {
  const send = readFileSync("lib/sendOutreach.ts", "utf8");
  const customize = readFileSync("app/dashboard/customize/[showId]/[contactId]/page.tsx", "utf8");
  const preview = readFileSync("app/festivals/[showId]/customize/actions.ts", "utf8");
  const original = send.slice(send.indexOf("async function prepareOriginalOutreach"), send.indexOf("async function prepareFollowUpOutreach"));
  const followUp = send.slice(send.indexOf("async function prepareFollowUpOutreach"), send.indexOf("async function currentAttempt"));
  for (const path of [original, followUp, customize]) {
    assert.match(path, /festivalArtistsTemplateName\(/);
  }
  assert.match(preview, /festivalArtistTemplateName\(/);
  assert.match(original, /"original",\s*trackingArtistName,\s*utmSettings/);
  assert.match(followUp, /"follow_up",\s*trackingArtistName,\s*utmSettings/);
  assert.match(preview, /"original",\s*artistDisplayName\(contact\.artist\),/);
});
