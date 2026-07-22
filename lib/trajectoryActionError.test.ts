import assert from "node:assert/strict";
import test from "node:test";
import {
  captureTrajectoryAction,
  trajectoryActionErrorHref,
  trajectoryActionErrorMessage,
  trajectoryActionResultHref,
} from "./trajectoryActionError";
import {
  runAfterActionableTrajectoryValidation,
  TrajectoryActionError,
} from "./trajectoryActiveRun";
import { TrajectoryFeedbackError } from "./trajectoryFeedback";

test("trajectory action redirects preserve recommendation filters and returnTo", () => {
  const returnTo =
    "/recommendations?tab=trajectory&workflow=ready&date=10-45&returnTo=%2Fdashboard%3Fmode%3Dall-nyc";
  const href = trajectoryActionErrorHref(
    returnTo,
    new TrajectoryActionError(
      "recommendation_not_actionable",
      "Recommendation expired",
    ),
  );
  assert.ok(href);
  const url = new URL(href, "https://dashboard.local");
  assert.equal(url.pathname, "/recommendations");
  assert.equal(url.searchParams.get("tab"), "trajectory");
  assert.equal(url.searchParams.get("workflow"), "ready");
  assert.equal(url.searchParams.get("date"), "10-45");
  assert.equal(url.searchParams.get("returnTo"), "/dashboard?mode=all-nyc");
  assert.equal(url.searchParams.get("error"), "Recommendation expired");
});

test("only actionable trajectory failures are captured", async () => {
  const known = await captureTrajectoryAction("/recommendations", async () => {
    throw new TrajectoryFeedbackError(
      "recommendation_attribution_mismatch",
      "Recommendation target changed",
    );
  });
  assert.equal(known.ok, false);

  const unrelated = new TrajectoryFeedbackError(
    "idempotency_conflict",
    "Unrelated feedback conflict",
  );
  assert.equal(trajectoryActionErrorMessage(unrelated), null);
  await assert.rejects(
    captureTrajectoryAction("/recommendations", async () => {
      throw unrelated;
    }),
    (error) => error === unrelated,
  );
});

test("structured outreach failures redirect only when trajectory-specific", () => {
  assert.match(
    trajectoryActionResultHref("/recommendations?workflow=ready", {
      ok: false,
      error: "Recommendation superseded",
      trajectoryError: true,
    }) ?? "",
    /workflow=ready.*error=Recommendation\+superseded/,
  );
  assert.equal(
    trajectoryActionResultHref("/recommendations", {
      ok: false,
      error: "Provider unavailable",
    }),
    null,
  );
});

test("expired, superseded, and mismatched provisioning redirects without writes", async () => {
  const context = {
    recommendationId: "recommendation-1",
    runId: "run-1",
    showId: "show-1",
    artistId: "artist-1",
  };
  const target = { showId: "show-1", artistId: "artist-1" };
  const cases = [
    {
      context,
      validate: async () => {
        throw new TrajectoryActionError(
          "recommendation_not_actionable",
          "Recommendation expired",
        );
      },
    },
    {
      context,
      validate: async () => {
        throw new TrajectoryActionError(
          "recommendation_not_actionable",
          "Recommendation superseded",
        );
      },
    },
    {
      context: { ...context, artistId: "different-artist" },
      validate: async () => {},
    },
  ];

  for (const actionCase of cases) {
    let templateWrites = 0;
    const captured = await captureTrajectoryAction(
      "/recommendations?workflow=ready",
      () =>
        runAfterActionableTrajectoryValidation(
          actionCase.context,
          target,
          async () => {
            templateWrites += 1;
            return "template";
          },
          actionCase.validate,
        ),
    );
    assert.equal(captured.ok, false);
    if (!captured.ok) {
      assert.match(captured.errorHref, /^\/recommendations\?/);
      assert.match(captured.errorHref, /workflow=ready/);
      assert.match(captured.errorHref, /error=/);
    }
    assert.equal(templateWrites, 0);
  }

  let validWrites = 0;
  const valid = await captureTrajectoryAction("/recommendations", () =>
    runAfterActionableTrajectoryValidation(
      context,
      target,
      async () => {
        validWrites += 1;
        return "template";
      },
      async () => {},
    ),
  );
  assert.deepEqual(valid, { ok: true, value: "template" });
  assert.equal(validWrites, 1);
});
