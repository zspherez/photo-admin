import assert from "node:assert/strict";
import test from "node:test";
import {
  executeTrajectoryFeedbackAction,
  executeTrajectoryOutcomeAction,
  type TrajectoryFeedbackActionDependencies,
} from "./trajectoryFeedbackActions";

function baseForm(): FormData {
  const form = new FormData();
  form.set("recommendationId", "recommendation-1");
  form.set("runId", "run-1");
  form.set("showId", "show-1");
  form.set("artistId", "artist-1");
  form.set("idempotencyKey", "key-1");
  return form;
}

function dependencies(
  overrides: Partial<TrajectoryFeedbackActionDependencies> = {},
): TrajectoryFeedbackActionDependencies {
  return {
    authorize: async () => {},
    recordFeedback: async () => {
      throw new Error("unused");
    },
    recordOutcome: async () => {
      throw new Error("unused");
    },
    attributeOutreach: async () => {
      throw new Error("unused");
    },
    refresh: () => {},
    ...overrides,
  };
}

test("feedback action authenticates before writing and exposes manual override", async () => {
  const order: string[] = [];
  const form = baseForm();
  form.set("action", "manual_override");
  await executeTrajectoryFeedbackAction(
    form,
    dependencies({
      authorize: async () => {
        order.push("auth");
      },
      recordFeedback: async (input) => {
        order.push("write");
        assert.equal(input.action, "manual_override");
        return {
          created: true,
          event: {
            id: "feedback-1",
            recommendationId: input.recommendationId,
            action: input.action,
            propensity: null,
            manualOverride: true,
            notes: null,
            idempotencyKey: input.idempotencyKey,
            supersedesId: null,
            recordedAt: new Date(),
          },
        };
      },
      refresh: () => order.push("refresh"),
    }),
  );
  assert.deepEqual(order, ["auth", "write", "refresh"]);
});

test("unauthenticated actions never reach persistence", async () => {
  const form = baseForm();
  form.set("attended", "true");
  let wrote = false;
  await assert.rejects(
    executeTrajectoryOutcomeAction(
      form,
      dependencies({
        authorize: async () => {
          throw new Error("Unauthorized");
        },
        recordOutcome: async () => {
          wrote = true;
          throw new Error("must not run");
        },
      }),
    ),
    /Unauthorized/,
  );
  assert.equal(wrote, false);
});

test("outcome action parses the full structured photography result", async () => {
  const form = baseForm();
  form.set("attended", "true");
  form.set("access", "photo_pass");
  form.set("keeperCount", "12");
  form.set("relationshipValue", "2");
  form.set("publicationValue", "1");
  form.set("shootability", "good");
  form.set("venueAccessibility", "medium");
  form.set("notes", "Private operational detail");
  form.set("supersedesId", "outcome-previous");
  let refreshed = false;

  await executeTrajectoryOutcomeAction(
    form,
    dependencies({
      recordOutcome: async (input) => {
        assert.deepEqual(input, {
          recommendationId: "recommendation-1",
          runId: "run-1",
          showId: "show-1",
          artistId: "artist-1",
          attended: true,
          access: "photo_pass",
          keeperCount: 12,
          relationshipValue: 2,
          publicationValue: 1,
          shootability: "good",
          venueAccessibility: "medium",
          notes: "Private operational detail",
          idempotencyKey: "key-1",
          supersedesId: "outcome-previous",
        });
        return {
          created: true,
          outcome: {
            id: "outcome-1",
            recommendationId: input.recommendationId,
            attended: true,
            access: "photo_pass",
            keeperCount: 12,
            relationshipValue: 2,
            publicationValue: 1,
            shootability: "good",
            venueAccessibility: "medium",
            notes: "Private operational detail",
            idempotencyKey: input.idempotencyKey,
            supersedesId: "outcome-previous",
            recordedAt: new Date(),
          },
        };
      },
      refresh: () => {
        refreshed = true;
      },
    }),
  );
  assert.equal(refreshed, true);
});
