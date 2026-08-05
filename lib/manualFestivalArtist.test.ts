import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseManualFestivalArtist,
  manualFestivalArtistRemoval,
  type ManualFestivalArtistCandidate,
} from "./manualFestivalArtist";

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
  assert.deepEqual(
    chooseManualFestivalArtist(
      [candidate("one", true), candidate("two", true)],
      null,
    ),
    {
      kind: "already-on-lineup",
      candidate: candidate("one", true),
    },
  );
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
