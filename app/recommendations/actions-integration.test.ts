import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function exportedAction(sourceText: string, name: string, nextName: string) {
  return sourceText.slice(
    sourceText.indexOf(`export async function ${name}`),
    sourceText.indexOf(`export async function ${nextName}`),
  );
}

test("every reused recommendation mutation remains authenticated", () => {
  const actions = source("app/dashboard/actions.ts");
  const names = [
    ["sendNowAction", "sendFollowUpAction"],
    ["sendFollowUpAction", "cancelScheduledAction"],
    ["cancelScheduledAction", "dismissShowAction"],
    ["dismissShowAction", "restoreShowAction"],
    ["restoreShowAction", "setInterestedAction"],
    ["setInterestedAction", "markSentAction"],
    ["markSentAction", "unmarkSentAction"],
  ] as const;
  for (const [name, nextName] of names) {
    assert.match(
      exportedAction(actions, name, nextName),
      /requireServerActionAuth/,
      name,
    );
  }
  assert.match(
    actions.slice(actions.indexOf("export async function unmarkSentAction")),
    /requireServerActionAuth/,
  );
});

test("recommendation actions carry exact IDs and preserve send policy helpers", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  const recommendations = source("lib/trajectoryRecommendations.ts");
  const send = source("lib/sendOutreach.ts");
  for (const action of [
    "sendNowAction",
    "setInterestedAction",
    "dismissShowAction",
    "restoreShowAction",
    "markSentAction",
    "unmarkSentAction",
    "sendFollowUpAction",
    "cancelScheduledAction",
  ]) {
    assert.match(client, new RegExp(action));
  }
  assert.match(client, /name: "recommendationId"/);
  assert.match(client, /name: "runId"/);
  assert.match(client, /name: "artistId"/);
  assert.match(client, /name="showId"/);
  assert.match(recommendations, /getOutreachSendabilityBatch/);
  assert.match(recommendations, /getFollowUpEligibilityBatch/);
  assert.match(send, /getOutreachSendabilityBatch/);
  assert.match(send, /evaluateOutreachDeliveryPolicy/);
  assert.doesNotMatch(recommendations, /emailSuppression\.findMany/);
});

test("outreach and decisions retain exact recommendation attribution", () => {
  const actions = source("app/dashboard/actions.ts");
  const send = source("lib/sendOutreach.ts");
  assert.match(
    send,
    /trajectoryRecommendationId:\s*trajectoryContext\?\.recommendationId \?\? null/,
  );
  assert.doesNotMatch(actions, /attributeTrajectoryOutreach/);
  assert.match(actions, /sendFollowUp\(parentOutreachId, recommendation/);
  assert.match(
    actions,
    /scheduleFollowUp\([\s\S]*recommendation \?\? undefined/,
  );
  assert.match(
    actions,
    /trajectoryRecommendationId:\s*recommendation\.recommendationId/,
  );
  assert.match(actions, /recordTrajectoryFeedbackInTransaction\(/);
  assert.match(actions, /recommendations\/\$\{action\}\/\$\{actionId\}/);
});

test("stale recommendation failures redirect before action mutations", () => {
  const actions = source("app/dashboard/actions.ts");
  for (const [name, nextName] of [
    ["sendNowAction", "queueForNextDispatchAction"],
    ["queueForNextDispatchAction", "sendFollowUpAction"],
    ["sendFollowUpAction", "cancelScheduledAction"],
    ["cancelScheduledAction", "dismissShowAction"],
    ["dismissShowAction", "restoreShowAction"],
    ["restoreShowAction", "setInterestedAction"],
    ["setInterestedAction", "markSentAction"],
    ["markSentAction", "unmarkSentAction"],
  ] as const) {
    assert.match(
      exportedAction(actions, name, nextName),
      /captureTrajectoryAction/,
      name,
    );
  }
  assert.match(
    actions.slice(actions.indexOf("export async function unmarkSentAction")),
    /captureTrajectoryAction/,
  );

  for (const name of [
    "dismissShowAction",
    "restoreShowAction",
    "setInterestedAction",
  ]) {
    const action = actions.slice(
      actions.indexOf(`export async function ${name}`),
      actions.indexOf(
        "\nexport async function ",
        actions.indexOf(`export async function ${name}`) + 1,
      ),
    );
    assert.match(action, /const mutate = async \(\) => \{[\s\S]*tx\.show\./);
    assert.match(
      action,
      /runActionableTrajectoryMutation\(tx, recommendation, mutate\)/,
    );
  }

  const customize = source(
    "app/dashboard/customize/[showId]/[contactId]/actions.ts",
  );
  assert.match(customize, /captureTrajectoryAction\(returnTo/);
  assert.match(customize, /trajectoryActionResultHref\(returnTo, result\)/);
});

test("customize keeps normal templates, explicit send/schedule/queue, and return state", () => {
  const page = source(
    "app/dashboard/customize/[showId]/[contactId]/page.tsx",
  );
  const actions = source(
    "app/dashboard/customize/[showId]/[contactId]/actions.ts",
  );
  const form = source(
    "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
  );
  assert.match(page, /ensureOriginalTemplateForShow\(show\)/);
  assert.match(page, /runAfterActionableTrajectoryValidation/);
  assert.match(page, /redirect\(capturedTemplate\.errorHref\)/);
  assert.match(actions, /trajectoryContext: context\.trajectoryContext/);
  assert.match(actions, /intent === "queue"/);
  assert.match(actions, /getNextNormalOutreachDispatch/);
  assert.match(actions, /getNextMondaySlot/);
  assert.match(form, /value="send"/);
  assert.match(form, /value="queue"/);
});

test("dashboard badges decorate only existing matched rows without changing matching", () => {
  const page = source("app/dashboard/page.tsx");
  const interaction = source("lib/dashboardInteractionState.ts");
  const match = source("lib/match.ts");
  const client = source("app/dashboard/dashboard-client.tsx");
  assert.match(page, /getDashboardData\(query, ownerKey, now\)/);
  assert.match(
    interaction,
    /getDashboardRecommendationBadges\(shows, now\)/,
  );
  assert.doesNotMatch(match, /trajectoryRecommendation|trajectoryModelRun/);
  assert.match(client, /Model recommendation/);
  assert.match(client, /recommendationBadgeByTarget/);
});

test("same-night alternatives keep actions scoped to each selected card", () => {
  const client = source("app/recommendations/recommendations-client.tsx");
  assert.match(client, /group\.recommendations\.map\(\(recommendation\)/);
  assert.match(client, /showId=\{recommendation\.showId\}/);
  assert.match(
    client,
    /contactId=\{recommendation\.emailContact\?\.id \?\? null\}/,
  );
  assert.doesNotMatch(client, /group\.recommendations\.map\([\s\S]*showId\[\]/);
});
