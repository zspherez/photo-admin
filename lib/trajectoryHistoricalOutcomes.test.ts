import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  getHistoricalOutcomeRecommendationPage,
  type HistoricalOutcomeQuery,
  type HistoricalOutcomeStore,
} from "./trajectoryHistoricalOutcomes";

const NOW = new Date("2026-07-22T03:30:00.000Z");

function recommendation(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    runId: `run-${id}`,
    arm: "trajectory",
    feedback: [],
    outcomes: [],
    run: {
      producerRunId: `producer-${id}`,
      status: "superseded",
      generatedAt: new Date("2026-07-20T12:00:00.000Z"),
    },
    show: {
      id: `show-${id}`,
      date: new Date("2026-07-21T00:00:00.000Z"),
      venueName: "Canonical venue",
      eventName: null,
      city: "Brooklyn",
      state: "NY",
    },
    runArtist: {
      edmtrainArtistId: 123,
      artist: {
        id: `artist-${id}`,
        name: `Artist ${id}`,
      },
    },
    ...overrides,
  };
}

function store(
  rows: unknown[],
  capture: (query: HistoricalOutcomeQuery) => void = () => {},
): HistoricalOutcomeStore {
  return {
    countRecommendations: async (query) => {
      capture(query);
      return rows.length;
    },
    findRecommendations: async (query) => {
      capture(query);
      return rows.slice(query.offset, query.offset + query.limit) as never;
    },
  };
}

test("historical outcomes request ready, stale, and superseded runs using Eastern today", async () => {
  const queries: HistoricalOutcomeQuery[] = [];
  await getHistoricalOutcomeRecommendationPage({
    now: NOW,
    store: store([recommendation("one")], (query) => queries.push(query)),
  });
  assert.ok(queries.length >= 1);
  assert.deepEqual(queries[0].statuses, ["ready", "stale", "superseded"]);
  assert.equal(queries[0].today.toISOString(), "2026-07-21T00:00:00.000Z");
});

test("historical results retain exact run, recommendation, artist, and correction history", async () => {
  const result = await getHistoricalOutcomeRecommendationPage({
    now: NOW,
    store: store([
      recommendation("exact", {
        feedback: [
          {
            id: "feedback-current",
            action: "selected",
            propensity: null,
            manualOverride: false,
            notes: "private",
            supersedesId: "feedback-old",
            recordedAt: new Date("2026-07-21T13:00:00.000Z"),
          },
          {
            id: "feedback-old",
            action: "saved",
            propensity: null,
            manualOverride: false,
            notes: null,
            supersedesId: null,
            recordedAt: new Date("2026-07-21T12:00:00.000Z"),
          },
        ],
      }),
    ]),
  });
  const [row] = result.recommendations;
  assert.equal(row.id, "exact");
  assert.equal(row.runId, "run-exact");
  assert.equal(row.producerRunId, "producer-exact");
  assert.equal(row.showId, "show-exact");
  assert.equal(row.artistId, "artist-exact");
  assert.equal(row.edmtrainArtistId, 123);
  assert.equal(row.decisionHistory[0].isCurrent, true);
  assert.equal(row.decisionHistory[0].notes, "private");
});

test("existing outcomes remain correctable after a canonical date moves forward", async () => {
  const result = await getHistoricalOutcomeRecommendationPage({
    now: NOW,
    store: store([
      recommendation("moved", {
        show: {
          ...recommendation("moved").show,
          date: new Date("2026-07-25T00:00:00.000Z"),
        },
        outcomes: [
          {
            id: "outcome-current",
            attended: true,
            access: "photo_pass",
            keeperCount: 4,
            relationshipValue: 1,
            publicationValue: 0,
            shootability: "good",
            venueAccessibility: "medium",
            notes: null,
            supersedesId: null,
            recordedAt: new Date("2026-07-21T12:00:00.000Z"),
          },
        ],
      }),
    ]),
  });
  assert.equal(result.recommendations[0].outcomeRecordable, true);
  assert.match(
    result.recommendations[0].outcomeRecordabilityMessage ?? "",
    /Correction remains available/,
  );
});

test("default query includes occurred shows and existing outcomes after date changes", () => {
  const source = fs.readFileSync(
    new URL("./trajectoryHistoricalOutcomes.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /status: \{ in: \[\.\.\.query\.statuses\] \}/);
  assert.match(source, /date: \{ lte: query\.today \}/);
  assert.match(source, /outcomes: \{ some: \{\} \}/);
});
