import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeTrajectoryOutreach,
  recordTrajectoryFeedback,
  recordTrajectoryOutcome,
  TrajectoryFeedbackError,
  trajectoryOutcomeInputSchema,
  trajectoryFeedbackInputSchema,
  type StoredTrajectoryFeedback,
  type StoredTrajectoryOutcome,
  type TrajectoryFeedbackPersistence,
  type TrajectoryOutreachContext,
  type TrajectoryRecommendationContext,
} from "./trajectoryFeedback";

const now = new Date("2026-07-21T16:00:00.000Z");

function recommendation(
  overrides: Partial<TrajectoryRecommendationContext> = {},
): TrajectoryRecommendationContext {
  return {
    id: "recommendation-1",
    runId: "run-1",
    showId: "show-1",
    artistId: "artist-1",
    runStatus: "ready",
    validUntil: new Date("2026-07-22T16:00:00.000Z"),
    showDate: new Date("2026-07-21T00:00:00.000Z"),
    showSyncStatus: "active",
    ...overrides,
  };
}

function fakePersistence(options: {
  recommendations?: TrajectoryRecommendationContext[];
  outreaches?: TrajectoryOutreachContext[];
} = {}) {
  const recommendations =
    options.recommendations ?? [recommendation()];
  const feedback: StoredTrajectoryFeedback[] = [];
  const outcomes: StoredTrajectoryOutcome[] = [];
  const outreaches = options.outreaches ?? [];

  const persistence: TrajectoryFeedbackPersistence = {
    async withTransaction(work) {
      return work({
        async findRecommendation(id) {
          return recommendations.find((row) => row.id === id) ?? null;
        },
        async findFeedbackByIdempotencyKey(key) {
          return feedback.find((row) => row.idempotencyKey === key) ?? null;
        },
        async findFeedback(id) {
          return feedback.find((row) => row.id === id) ?? null;
        },
        async createFeedback(input, recordedAt) {
          const row: StoredTrajectoryFeedback = {
            id: `feedback-${feedback.length + 1}`,
            recommendationId: input.recommendationId,
            action: input.action,
            propensity: input.propensity,
            manualOverride: input.manualOverride,
            notes: input.notes,
            idempotencyKey: input.idempotencyKey,
            supersedesId: input.supersedesId,
            recordedAt,
          };
          feedback.push(row);
          return row;
        },
        async findOutcomeByIdempotencyKey(key) {
          return outcomes.find((row) => row.idempotencyKey === key) ?? null;
        },
        async findOutcome(id) {
          return outcomes.find((row) => row.id === id) ?? null;
        },
        async createOutcome(input, recordedAt) {
          const row: StoredTrajectoryOutcome = {
            id: `outcome-${outcomes.length + 1}`,
            recommendationId: input.recommendationId,
            attended: input.attended,
            access: input.access,
            keeperCount: input.keeperCount,
            relationshipValue: input.relationshipValue,
            publicationValue: input.publicationValue,
            shootability: input.shootability,
            venueAccessibility: input.venueAccessibility,
            notes: input.notes,
            idempotencyKey: input.idempotencyKey,
            supersedesId: input.supersedesId,
            recordedAt,
          };
          outcomes.push(row);
          return row;
        },
        async findOutreach(id) {
          return outreaches.find((row) => row.id === id) ?? null;
        },
        async attributeOutreach(id, recommendationId) {
          const outreach = outreaches.find((row) => row.id === id);
          assert.ok(outreach);
          outreach.trajectoryRecommendationId = recommendationId;
        },
      });
    },
  };
  return { persistence, feedback, outcomes, outreaches };
}

const attribution = {
  recommendationId: "recommendation-1",
  runId: "run-1",
  showId: "show-1",
  artistId: "artist-1",
};

test("all planned feedback actions validate with exact manual override semantics", () => {
  for (const action of [
    "selected",
    "declined",
    "saved",
    "dismissed",
    "manual_override",
  ] as const) {
    const parsed = trajectoryFeedbackInputSchema.parse({
      ...attribution,
      action,
      idempotencyKey: `key-${action}`,
    });
    assert.equal(parsed.manualOverride, action === "manual_override");
  }
});

test("feedback corrections append superseding rows and idempotent retries do not mutate history", async () => {
  const state = fakePersistence();
  const first = await recordTrajectoryFeedback(
    {
      ...attribution,
      action: "selected",
      propensity: 0.75,
      notes: "Initial choice",
      idempotencyKey: "feedback-key-1",
    },
    { persistence: state.persistence, now: () => now },
  );
  const correction = await recordTrajectoryFeedback(
    {
      ...attribution,
      action: "saved",
      idempotencyKey: "feedback-key-2",
      supersedesId: first.event.id,
    },
    { persistence: state.persistence, now: () => new Date(now.getTime() + 1) },
  );
  const retry = await recordTrajectoryFeedback(
    {
      ...attribution,
      action: "saved",
      idempotencyKey: "feedback-key-2",
      supersedesId: first.event.id,
    },
    { persistence: state.persistence, now: () => new Date(now.getTime() + 2) },
  );

  assert.equal(correction.created, true);
  assert.equal(retry.created, false);
  assert.equal(state.feedback.length, 2);
  assert.equal(state.feedback[0].action, "selected");
  assert.equal(state.feedback[1].supersedesId, state.feedback[0].id);
});

test("feedback idempotency keys reject different evidence", async () => {
  const state = fakePersistence();
  await recordTrajectoryFeedback(
    {
      ...attribution,
      action: "selected",
      idempotencyKey: "same-key",
    },
    { persistence: state.persistence, now: () => now },
  );
  await assert.rejects(
    recordTrajectoryFeedback(
      {
        ...attribution,
        action: "declined",
        idempotencyKey: "same-key",
      },
      { persistence: state.persistence, now: () => now },
    ),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "idempotency_conflict",
  );
});

test("cross-recommendation corrections are rejected", async () => {
  const state = fakePersistence({
    recommendations: [
      recommendation(),
      recommendation({
        id: "recommendation-2",
        runId: "run-2",
        showId: "show-2",
        artistId: "artist-2",
      }),
    ],
  });
  const first = await recordTrajectoryFeedback(
    {
      ...attribution,
      action: "selected",
      idempotencyKey: "first",
    },
    { persistence: state.persistence, now: () => now },
  );
  await assert.rejects(
    recordTrajectoryFeedback(
      {
        recommendationId: "recommendation-2",
        runId: "run-2",
        showId: "show-2",
        artistId: "artist-2",
        action: "declined",
        idempotencyKey: "second",
        supersedesId: first.event.id,
      },
      { persistence: state.persistence, now: () => now },
    ),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "cross_recommendation_supersession",
  );
});

test("stale recommendations still accept historical outcomes but not new decisions", async () => {
  const state = fakePersistence({
    recommendations: [
      recommendation({
        runStatus: "superseded",
        validUntil: new Date("2026-07-20T16:00:00.000Z"),
        showSyncStatus: "inactive",
      }),
    ],
  });

  const result = await recordTrajectoryOutcome(
    {
      ...attribution,
      attended: true,
      access: "photo_pass",
      keeperCount: 8,
      relationshipValue: 2,
      publicationValue: 1,
      shootability: "good",
      venueAccessibility: "medium",
      notes: "Operational note retained only in photo-admin",
      idempotencyKey: "outcome-key",
    },
    { persistence: state.persistence, now: () => now },
  );
  assert.equal(result.created, true);
  assert.equal(result.outcome.keeperCount, 8);

  await assert.rejects(
    recordTrajectoryFeedback(
      {
        ...attribution,
        action: "selected",
        idempotencyKey: "late-decision",
      },
      { persistence: state.persistence, now: () => now },
    ),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "recommendation_not_actionable",
  );
});

test("initial outcomes use canonical UTC show dates and the current Eastern day", async () => {
  const state = fakePersistence({
    recommendations: [
      recommendation({
        showDate: new Date("2026-07-22T00:00:00.000Z"),
      }),
    ],
  });
  const input = {
    ...attribution,
    attended: true,
    idempotencyKey: "outcome-date-gate",
  };

  await assert.rejects(
    recordTrajectoryOutcome(input, {
      persistence: state.persistence,
      now: () => new Date("2026-07-22T03:59:59.999Z"),
    }),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "show_not_occurred",
  );
  assert.equal(state.outcomes.length, 0);

  await recordTrajectoryOutcome(input, {
    persistence: state.persistence,
    now: () => new Date("2026-07-22T04:00:00.000Z"),
  });
  assert.equal(state.outcomes.length, 1);
});

test("past and today outcomes are accepted while future outcomes are rejected", async () => {
  for (const [showDate, accepted] of [
    ["2026-07-20T00:00:00.000Z", true],
    ["2026-07-21T00:00:00.000Z", true],
    ["2026-07-22T00:00:00.000Z", false],
  ] as const) {
    const state = fakePersistence({
      recommendations: [recommendation({ showDate: new Date(showDate) })],
    });
    const promise = recordTrajectoryOutcome(
      {
        ...attribution,
        attended: false,
        idempotencyKey: `date-${showDate}`,
      },
      { persistence: state.persistence, now: () => now },
    );
    if (accepted) {
      await promise;
      assert.equal(state.outcomes.length, 1);
    } else {
      await assert.rejects(
        promise,
        (error) =>
          error instanceof TrajectoryFeedbackError &&
          error.code === "show_not_occurred",
      );
      assert.equal(state.outcomes.length, 0);
    }
  }
});

test("canonical date changes block premature roots but not corrections", async () => {
  const mutable = recommendation();
  const state = fakePersistence({ recommendations: [mutable] });
  const first = await recordTrajectoryOutcome(
    {
      ...attribution,
      attended: true,
      keeperCount: 4,
      idempotencyKey: "before-date-change",
    },
    { persistence: state.persistence, now: () => now },
  );

  mutable.showDate = new Date("2026-07-25T00:00:00.000Z");
  await assert.rejects(
    recordTrajectoryOutcome(
      {
        ...attribution,
        attended: false,
        idempotencyKey: "new-root-after-date-change",
      },
      { persistence: state.persistence, now: () => now },
    ),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "show_not_occurred",
  );

  await recordTrajectoryOutcome(
    {
      ...attribution,
      attended: true,
      keeperCount: 6,
      idempotencyKey: "correction-after-date-change",
      supersedesId: first.outcome.id,
    },
    { persistence: state.persistence, now: () => now },
  );
  assert.equal(state.outcomes.length, 2);
});

test("outcome retries remain idempotent after the run stops accepting new outcomes", async () => {
  const mutableRecommendation = recommendation();
  const state = fakePersistence({
    recommendations: [mutableRecommendation],
  });
  const input = {
    ...attribution,
    attended: true,
    keeperCount: 4,
    idempotencyKey: "stable-outcome-key",
  };
  const first = await recordTrajectoryOutcome(input, {
    persistence: state.persistence,
    now: () => now,
  });

  mutableRecommendation.runStatus = "failed";

  const retry = await recordTrajectoryOutcome(input, {
    persistence: state.persistence,
    now: () => new Date(now.getTime() + 1),
  });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.outcome.id, first.outcome.id);
  assert.equal(state.outcomes.length, 1);
});

test("outcome validation enforces utility ranges and attendance consistency", () => {
  assert.throws(() =>
    trajectoryOutcomeInputSchema.parse({
      ...attribution,
      attended: false,
      keeperCount: 1,
      relationshipValue: 3,
      idempotencyKey: "bad-outcome",
    }),
  );
  assert.throws(() =>
    trajectoryOutcomeInputSchema.parse({
      ...attribution,
      notes: "notes alone are not structured evidence",
      idempotencyKey: "notes-only",
    }),
  );
});

test("outreach attribution is exact, immutable, and idempotent", async () => {
  const state = fakePersistence({
    outreaches: [
      {
        id: "outreach-1",
        showId: "show-1",
        artistId: "artist-1",
        trajectoryRecommendationId: null,
      },
      {
        id: "outreach-2",
        showId: "show-1",
        artistId: "artist-1",
        trajectoryRecommendationId: "recommendation-other",
      },
    ],
  });
  assert.deepEqual(
    await attributeTrajectoryOutreach(
      { ...attribution, outreachId: "outreach-1" },
      { persistence: state.persistence },
    ),
    { attributed: true },
  );
  assert.deepEqual(
    await attributeTrajectoryOutreach(
      { ...attribution, outreachId: "outreach-1" },
      { persistence: state.persistence },
    ),
    { attributed: false },
  );
  await assert.rejects(
    attributeTrajectoryOutreach(
      { ...attribution, outreachId: "outreach-2" },
      { persistence: state.persistence },
    ),
    (error) =>
      error instanceof TrajectoryFeedbackError &&
      error.code === "outreach_already_attributed",
  );
});
