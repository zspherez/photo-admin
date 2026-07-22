import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const formSource = readFileSync(
  new URL("./queue-management-forms.tsx", import.meta.url),
  "utf8",
);
const actionSource = readFileSync(
  new URL("./actions.ts", import.meta.url),
  "utf8",
);
const contractSource = readFileSync(
  new URL("../../../lib/queueManagementContract.ts", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../page.tsx", import.meta.url),
  "utf8",
);

test("settings links to queue management and shows separate live counts", () => {
  assert.match(settingsSource, /title: "Queue management"/);
  assert.match(settingsSource, /href: "\/settings\/queue-management"/);
  assert.match(pageSource, /readQueueManagementCounts/);
  assert.match(formSource, /auditDecisions\.toLocaleString\(\)/);
  assert.match(formSource, /researchReviews\.toLocaleString\(\)/);
  assert.match(formSource, /pendingResearchJobs\.toLocaleString\(\)/);
  assert.match(formSource, /claimedResearchJobs\.toLocaleString\(\)/);
});

test("each queue operation has its own exact typed confirmation and result", () => {
  for (const confirmation of [
    "REJECT AUDIT DECISIONS",
    "REQUEUE REVIEW RESEARCH",
    "DEACTIVATE RESEARCH QUEUE",
  ]) {
    assert.match(contractSource, new RegExp(confirmation));
  }
  assert.equal(formSource.match(/useActionState\(/g)?.length, 3);
  assert.equal(formSource.match(/<Result state=/g)?.length, 3);
  assert.equal(actionSource.match(/requireServerActionAuth\(/g)?.length, 3);
  assert.match(actionSource, /retryAllReviewContactResearchJobs/);
  assert.match(actionSource, /rejectUnresolvedFlaggedAuditDecisions/);
  assert.match(actionSource, /deactivatePendingAndClaimedResearchJobs/);
});

test("queue management preserves history and warns about hourly refill", () => {
  assert.match(formSource, /without changing contacts or deleting audit/);
  assert.match(formSource, /candidates and evidence remain intact/);
  assert.match(formSource, /Job history, notes,[\s\S]*are not deleted/);
  assert.match(formSource, /hourly contact-research workflow/);
  assert.match(formSource, /minute 23/);
  assert.doesNotMatch(formSource + actionSource, /\.delete(?:Many)?\(/);
});
