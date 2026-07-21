import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveTrajectoryRecommendationAttribution } from "./sendOutreach";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("explicit follow-up attribution targets the current recommendation without changing its older parent", () => {
  assert.equal(
    resolveTrajectoryRecommendationAttribution(
      "current-recommendation",
      "older-parent-recommendation",
    ),
    "current-recommendation",
  );

  const actions = source("app/dashboard/actions.ts");
  const followUp = actions.slice(
    actions.indexOf("export async function sendFollowUpAction"),
    actions.indexOf("export async function cancelScheduledAction"),
  );
  assert.doesNotMatch(followUp, /attributeTrajectoryOutreach|outreach\.update/);
  assert.match(
    followUp,
    /sendFollowUp\(parentOutreachId, recommendation \?\? undefined\)/,
  );
  assert.match(
    followUp,
    /scheduleFollowUp\([\s\S]*recommendation \?\? undefined/,
  );
});

test("follow-up creation validates explicit context and attributes only the child in its write transaction", () => {
  const send = source("lib/sendOutreach.ts");
  const preparation = send.slice(
    send.indexOf("async function prepareFollowUpOutreach"),
    send.indexOf("async function currentAttempt"),
  );
  assert.match(
    preparation,
    /trajectoryRecommendationId: parent\.trajectoryRecommendationId/,
  );
  assert.match(
    preparation,
    /trajectoryContext: trajectoryContext \?\? null/,
  );

  for (const claimName of [
    "async function claimImmediateOutreach",
    "async function schedulePreparedOutreach",
  ]) {
    const claim = send.slice(
      send.indexOf(claimName),
      send.indexOf(
        claimName === "async function claimImmediateOutreach"
          ? "async function releasePreparationFailure"
          : "export async function scheduleOutreach",
      ),
    );
    assert.ok(
      claim.indexOf("preparedTrajectoryBlockingReason") <
        claim.indexOf("tx.outreach.create"),
    );
    assert.match(
      claim,
      /tx\.outreach\.create\([\s\S]*trajectoryAttributionData\(prep\)/,
    );
  }
});

test("failed pre-claim follow-ups cannot create false parent or child attribution", () => {
  const send = source("lib/sendOutreach.ts");
  const followUp = send.slice(
    send.indexOf("export async function sendFollowUp"),
    send.indexOf("async function schedulePreparedOutreach"),
  );
  assert.ok(
    followUp.indexOf('if ("error" in prep)') <
      followUp.indexOf("claimImmediateOutreach(prep)"),
  );
  assert.doesNotMatch(followUp, /outreach\.(update|create)/);
});

test("follow-up retry attribution is idempotent and default calls inherit without erasing explicit child attribution", () => {
  assert.equal(
    resolveTrajectoryRecommendationAttribution(
      null,
      "parent-recommendation",
    ),
    "parent-recommendation",
  );
  assert.equal(
    resolveTrajectoryRecommendationAttribution(
      null,
      "parent-recommendation",
      "explicit-child-recommendation",
    ),
    "explicit-child-recommendation",
  );
  assert.equal(
    resolveTrajectoryRecommendationAttribution(
      "current-recommendation",
      "parent-recommendation",
      "older-child-recommendation",
    ),
    "current-recommendation",
  );

  const send = source("lib/sendOutreach.ts");
  assert.match(
    send,
    /trajectoryAttributionData\(\s*prep,\s*existing\.trajectoryRecommendationId/,
  );
  assert.match(
    send,
    /trajectoryAttributionData\(\s*prep,\s*queued\.trajectoryRecommendationId/,
  );
});

test("manual marks reject cross-artist and stale contacts before either write path", () => {
  const actions = source("app/dashboard/actions.ts");
  const mark = actions.slice(
    actions.indexOf("export async function markSentAction"),
    actions.indexOf("export async function unmarkSentAction"),
  );
  assert.match(
    mark,
    /contact\.artistId !== recommendation\.artistId/,
  );
  assert.match(mark, /tx\.contact\.findUnique/);
  assert.match(
    mark,
    /currentContact\.artistId !== targetArtistId/,
  );
  assert.match(
    mark,
    /currentContact\.artistId !== recommendation\.artistId/,
  );
  const transactionalCheck = mark.indexOf(
    'error: "Contact no longer matches the outreach artist"',
  );
  assert.ok(transactionalCheck > 0);
  assert.ok(transactionalCheck < mark.indexOf("tx.outreach.update"));
  assert.ok(transactionalCheck < mark.indexOf("tx.outreach.create"));
});

test("email sends recheck the selected contact artist under the delivery transaction", () => {
  const send = source("lib/sendOutreach.ts");
  const policy = send.slice(
    send.indexOf("async function preparedDeliveryPolicyBlockingReason"),
    send.indexOf("async function claimImmediateOutreach"),
  );
  assert.match(
    policy,
    /!contact \|\| contact\.artistId !== prep\.artistId/,
  );
  assert.match(
    policy,
    /Selected contact no longer belongs to the outreach artist/,
  );
});
