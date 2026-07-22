import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  runAfterActionableTrajectoryValidation,
  runActionableTrajectoryMutation,
  requireActionableTrajectoryRecommendationInTransaction,
  resolveTrajectoryRun,
  TrajectoryActionError,
  trajectoryActionContextFromFormData,
} from "./trajectoryActiveRun";

const now = new Date("2026-07-21T20:00:00.000Z");

test("stale, expired, and ambiguous trajectory runs are never actionable", async () => {
  const base = {
    id: "run-1",
    generatedAt: new Date("2026-07-21T18:00:00.000Z"),
    validUntil: new Date("2026-07-22T18:00:00.000Z"),
    status: "ready" as const,
  };
  assert.equal(
    (
      await resolveTrajectoryRun(now, {
        findReadyRuns: async () => [
          { ...base, generatedAt: new Date("2026-07-01T00:00:00.000Z") },
        ],
        findLatestRun: async () => null,
      })
    ).availability,
    "stale",
  );
  assert.equal(
    (
      await resolveTrajectoryRun(now, {
        findReadyRuns: async () => [
          { ...base, validUntil: new Date("2026-07-21T19:59:59.000Z") },
        ],
        findLatestRun: async () => null,
      })
    ).availability,
    "expired",
  );
  assert.equal(
    (
      await resolveTrajectoryRun(now, {
        findReadyRuns: async () => [base, { ...base, id: "run-2" }],
        findLatestRun: async () => null,
      })
    ).availability,
    "multiple_ready",
  );
});

test("recommendation action attribution is all-or-nothing and exact", () => {
  const empty = new FormData();
  assert.equal(trajectoryActionContextFromFormData(empty, "show-1"), null);

  const exact = new FormData();
  exact.set("recommendationId", "recommendation-1");
  exact.set("runId", "run-1");
  exact.set("artistId", "artist-1");
  assert.deepEqual(
    trajectoryActionContextFromFormData(exact, "show-1"),
    {
      recommendationId: "recommendation-1",
      runId: "run-1",
      showId: "show-1",
      artistId: "artist-1",
    },
  );

  exact.delete("artistId");
  assert.throws(
    () => trajectoryActionContextFromFormData(exact, "show-1"),
    /Incomplete trajectory recommendation attribution/,
  );
});

test("transactional recommendation validation checks the current run and exact target", async () => {
  let recommendationQuery: unknown;
  const tx = {
    trajectoryModelRun: {
      findMany: async () => [
        {
          id: "run-1",
          generatedAt: new Date("2026-07-21T18:00:00.000Z"),
          validUntil: new Date("2026-07-22T18:00:00.000Z"),
          status: "ready" as const,
        },
      ],
      findFirst: async () => null,
    },
    trajectoryRecommendation: {
      findFirst: async (query: unknown) => {
        recommendationQuery = query;
        return { id: "recommendation-1" };
      },
    },
  } as unknown as Prisma.TransactionClient;

  await requireActionableTrajectoryRecommendationInTransaction(
    tx,
    {
      recommendationId: "recommendation-1",
      runId: "run-1",
      showId: "show-1",
      artistId: "artist-1",
    },
    now,
  );

  assert.deepEqual(recommendationQuery, {
    where: {
      id: "recommendation-1",
      runId: "run-1",
      showId: "show-1",
      runArtist: { is: { artistId: "artist-1" } },
      show: { is: { syncStatus: "active" } },
    },
    select: { id: true },
  });
});

test("transactional recommendation failures do not run mutations", async () => {
  const context = {
    recommendationId: "recommendation-1",
    runId: "run-1",
    showId: "show-1",
    artistId: "artist-1",
  };
  let mutated = false;
  const tx = {
    trajectoryModelRun: {
      findMany: async () => [
        {
          id: "run-1",
          generatedAt: new Date("2026-07-21T18:00:00.000Z"),
          validUntil: new Date("2026-07-21T19:00:00.000Z"),
          status: "ready" as const,
        },
      ],
      findFirst: async () => null,
    },
    trajectoryRecommendation: {
      findFirst: async () => ({ id: "recommendation-1" }),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.rejects(
    runActionableTrajectoryMutation(
      tx,
      context,
      async () => {
        mutated = true;
      },
      now,
    ),
    (error) =>
      error instanceof TrajectoryActionError &&
      error.code === "recommendation_not_actionable",
  );
  assert.equal(mutated, false);
});

test("trajectory validation gates template provisioning", async () => {
  const context = {
    recommendationId: "recommendation-1",
    runId: "run-1",
    showId: "show-1",
    artistId: "artist-1",
  };
  const target = { showId: "show-1", artistId: "artist-1" };

  for (const message of [
    "The trajectory recommendation run expired",
    "The trajectory recommendation run was superseded",
  ]) {
    let templateWrites = 0;
    await assert.rejects(
      runAfterActionableTrajectoryValidation(
        context,
        target,
        async () => {
          templateWrites += 1;
          return "template";
        },
        async () => {
          throw new TrajectoryActionError(
            "recommendation_not_actionable",
            message,
          );
        },
      ),
      (error) =>
        error instanceof TrajectoryActionError &&
        error.code === "recommendation_not_actionable",
    );
    assert.equal(templateWrites, 0);
  }

  let mismatchWrites = 0;
  let mismatchValidated = false;
  await assert.rejects(
    runAfterActionableTrajectoryValidation(
      { ...context, artistId: "different-artist" },
      target,
      async () => {
        mismatchWrites += 1;
        return "template";
      },
      async () => {
        mismatchValidated = true;
      },
    ),
    (error) =>
      error instanceof TrajectoryActionError &&
      error.code === "recommendation_target_mismatch",
  );
  assert.equal(mismatchWrites, 0);
  assert.equal(mismatchValidated, false);

  let validWrites = 0;
  assert.equal(
    await runAfterActionableTrajectoryValidation(
      context,
      target,
      async () => {
        validWrites += 1;
        return "template";
      },
      async () => {},
    ),
    "template",
  );
  assert.equal(validWrites, 1);
});
