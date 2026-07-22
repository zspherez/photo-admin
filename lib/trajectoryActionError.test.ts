import assert from "node:assert/strict";
import test from "node:test";
import {
  captureTrajectoryAction,
  trajectoryActionErrorHref,
  trajectoryActionErrorMessage,
  trajectoryActionResultHref,
} from "./trajectoryActionError";
import { TrajectoryActionError } from "./trajectoryActiveRun";
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
