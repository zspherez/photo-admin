import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseManualFestivalArtist,
  parseManualFestivalArtistList,
  manualFestivalArtistRemoval,
  type ManualFestivalArtistCandidate,
} from "./manualFestivalArtist";

test("manual festival artist lists normalize and deduplicate pasted names", () => {
  assert.deepEqual(
    parseManualFestivalArtistList(
      "Artist One\n artist   one \nARTIST TWO\n\nArtist Three",
    ),
    {
      artists: [
        { name: "Artist One", normalizedName: "artist one" },
        { name: "ARTIST TWO", normalizedName: "artist two" },
        { name: "Artist Three", normalizedName: "artist three" },
      ],
      duplicateCount: 1,
      error: null,
    },
  );
});

test("manual festival artist lists are bounded and reject invalid names", () => {
  assert.match(
    parseManualFestivalArtistList("").error ?? "",
    /at least one/i,
  );
  assert.match(
    parseManualFestivalArtistList("!!!").error ?? "",
    /letters or numbers/i,
  );
  assert.match(
    parseManualFestivalArtistList(
      Array.from({ length: 201 }, (_, index) => `Artist ${index}`).join("\n"),
    ).error ?? "",
    /at most 200/i,
  );
});

const candidate = (
  id: string,
  onLineup = false,
): ManualFestivalArtistCandidate => ({
  id,
  name: "Same Name",
  spotifyId: null,
  statsfmId: null,
  edmtrainId: null,
  onLineup,
  manuallyAdded: false,
});

test("manual festival artists create only when no normalized match exists", () => {
  assert.deepEqual(chooseManualFestivalArtist([], null), { kind: "create" });
});

test("manual festival artists safely reuse one normalized candidate", () => {
  assert.deepEqual(chooseManualFestivalArtist([candidate("one")], null), {
    kind: "use",
    candidate: candidate("one"),
  });
});

test("manual festival artists require an explicit choice for ambiguous names", () => {
  const candidates = [candidate("one"), candidate("two")];
  assert.deepEqual(chooseManualFestivalArtist(candidates, null), {
    kind: "ambiguous",
    candidates,
  });
  assert.deepEqual(chooseManualFestivalArtist(candidates, "two"), {
    kind: "use",
    candidate: candidates[1],
  });
});

test("manual festival artists report an existing lineup association", () => {
  const existing = candidate("one", true);
  assert.deepEqual(chooseManualFestivalArtist([existing], null), {
    kind: "already-on-lineup",
    candidate: existing,
  });
});

test("ambiguous existing lineup rows can be explicitly selected", () => {
  const candidates = [candidate("one", true), candidate("two", true)];
  assert.deepEqual(chooseManualFestivalArtist(candidates, null), {
    kind: "ambiguous",
    candidates,
  });
  assert.deepEqual(chooseManualFestivalArtist(candidates, "two"), {
    kind: "already-on-lineup",
    candidate: candidates[1],
  });
});

test("manual removal never deletes provider ownership", () => {
  assert.equal(
    manualFestivalArtistRemoval({
      providerManaged: true,
      manuallyAdded: false,
    }),
    "provider-owned",
  );
  assert.equal(
    manualFestivalArtistRemoval({
      providerManaged: true,
      manuallyAdded: true,
    }),
    "retain-provider-association",
  );
  assert.equal(
    manualFestivalArtistRemoval({
      providerManaged: false,
      manuallyAdded: true,
    }),
    "delete-association",
  );
});
