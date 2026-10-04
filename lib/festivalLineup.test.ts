import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseFestivalLineupCandidate,
  dedupeFestivalArtistIds,
  FestivalLineupMergeSelectionError,
  parseFestivalLineupEntries,
  planFestivalLineupMerges,
} from "./festivalLineup";

const candidates = [
  { id: "artist-1", name: "Same Name" },
  { id: "artist-2", name: "Same Name" },
];

test("festival lineup creates only when no normalized candidate exists", () => {
  assert.deepEqual(chooseFestivalLineupCandidate([], null), {
    kind: "create",
  });
});

test("festival lineup automatically uses one exact normalized candidate", () => {
  assert.deepEqual(
    chooseFestivalLineupCandidate([candidates[0]], null),
    { kind: "use", candidate: candidates[0] }
  );
});

test("festival lineup requires an explicit valid choice when names are ambiguous", () => {
  assert.deepEqual(
    chooseFestivalLineupCandidate(candidates, null),
    { kind: "ambiguous", candidates }
  );
  assert.deepEqual(
    chooseFestivalLineupCandidate(candidates, "unknown"),
    { kind: "ambiguous", candidates }
  );
  assert.deepEqual(
    chooseFestivalLineupCandidate(candidates, "artist-2"),
    { kind: "use", candidate: candidates[1] }
  );
});

test("same-normalized lineup entries keep independent artist selections", () => {
  const parsed = parseFestivalLineupEntries(
    "Alpha & Beta\nAlpha and Beta"
  );

  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.entries.map((entry) => ({
      normalizedName: entry.normalizedName,
      selectionKey: entry.selectionKey,
    })),
    [
      {
        normalizedName: "alpha and beta",
        selectionKey: "artistChoice:0",
      },
      {
        normalizedName: "alpha and beta",
        selectionKey: "artistChoice:1",
      },
    ]
  );

  const selectedIds = parsed.entries.map((entry, index) => {
    const decision = chooseFestivalLineupCandidate(
      candidates,
      index === 0 ? "artist-1" : "artist-2"
    );
    assert.equal(decision.kind, "use", entry.selectionKey);
    return decision.kind === "use" ? decision.candidate.id : "";
  });
  assert.deepEqual(dedupeFestivalArtistIds(selectedIds), [
    "artist-1",
    "artist-2",
  ]);
  assert.deepEqual(
    dedupeFestivalArtistIds(["artist-1", "artist-1"]),
    ["artist-1"]
  );
});

test("confirmed same-artist records are merged into the selected canonical record", () => {
  const choice = {
    name: "HAYLA",
    normalizedName: "hayla",
    candidates: [
      { id: "statsfm-only" },
      { id: "spotify-and-edmtrain" },
    ],
    selectedId: "spotify-and-edmtrain",
    confirmed: true,
  };
  assert.deepEqual(planFestivalLineupMerges([choice]), [
    {
      name: "HAYLA",
      targetId: "spotify-and-edmtrain",
      sourceIds: ["statsfm-only"],
    },
  ]);
  assert.deepEqual(
    planFestivalLineupMerges([{ ...choice, confirmed: false }]),
    [],
  );
  assert.deepEqual(planFestivalLineupMerges([choice, choice]), [
    {
      name: "HAYLA",
      targetId: "spotify-and-edmtrain",
      sourceIds: ["statsfm-only"],
    },
  ]);
});

test("merge planning rejects stale, invalid, or inconsistent artist choices", () => {
  const choice = {
    name: "HAYLA",
    normalizedName: "hayla",
    candidates,
    selectedId: "artist-1",
    confirmed: true,
  };
  assert.throws(
    () => planFestivalLineupMerges([{ ...choice, selectedId: "unknown" }]),
    FestivalLineupMergeSelectionError,
  );
  assert.throws(
    () => planFestivalLineupMerges([{ ...choice, candidates: [] }]),
    FestivalLineupMergeSelectionError,
  );
  assert.throws(
    () =>
      planFestivalLineupMerges([
        choice,
        { ...choice, selectedId: "artist-2", confirmed: false },
      ]),
    /Every HAYLA lineup entry must select the same record/,
  );
  assert.throws(
    () =>
      planFestivalLineupMerges([
        choice,
        { ...choice, selectedId: "artist-2" },
      ]),
    /choose different records/,
  );
});
