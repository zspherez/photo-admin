import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const actionsSource = readFileSync(
  path.join(process.cwd(), "app/dashboard/actions.ts"),
  "utf8",
);
const dashboardSource = readFileSync(
  path.join(process.cwd(), "app/dashboard/dashboard-client.tsx"),
  "utf8",
);
const followUpButtonSource = readFileSync(
  path.join(process.cwd(), "components/follow-up-button.tsx"),
  "utf8",
);

function actionSource(name: string): string {
  const start = actionsSource.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = actionsSource.indexOf("\nexport async function ", start + 1);
  return actionsSource.slice(start, next === -1 ? undefined : next);
}

test("manual mark and unmark refresh server truth before redirecting with banners", () => {
  const mark = actionSource("markSentAction");
  const unmark = actionSource("unmarkSentAction");

  assert.ok(
    mark.indexOf("refreshWorkflowViews(returnTo") <
      mark.indexOf('dashboardResultHref(returnTo, "marked")'),
  );
  assert.match(mark, /festivalReturnPath\(showId\)/);

  assert.match(unmark, /MANUAL_OUTREACH_MARKER_WHERE/);
  assert.match(unmark, /removeManualOutreachMarker/);
  assert.match(unmark, /sendAttemptCount: row\._count\.sendAttempts/);
  assert.ok(
    unmark.indexOf("removeManualOutreachMarker") <
      unmark.indexOf("refreshWorkflowViews(returnTo"),
  );
  assert.ok(
    unmark.indexOf("refreshWorkflowViews(returnTo") <
      unmark.indexOf('dashboardResultHref(returnTo, "unmarked")'),
  );
  assert.match(unmark, /festivalReturnPath\(marker\.showId\)/);
  assert.match(
    dashboardSource,
    /const manualMarker = artistOutreaches\.find\([\s\S]*outreach\.isManualMarker/
  );
  assert.match(
    dashboardSource,
    /name="outreachId"[\s\S]*value=\{manualMarker\.id\}/
  );
});

test("inline dashboard mutations keep returnTo and refresh client state from server snapshots", () => {
  const pageSource = readFileSync(
    path.join(process.cwd(), "app/dashboard/page.tsx"),
    "utf8",
  );
  assert.match(
    pageSource,
    /key=\{`\$\{buildDashboardHref\(query\)\}:\$\{dashboard\.snapshotAt\.toISOString\(\)\}`\}/,
  );
  assert.ok(
    dashboardSource.match(/name="returnTo"/g)?.length &&
      (dashboardSource.match(/name="returnTo"/g)?.length ?? 0) >= 4,
    "dashboard mutation forms must carry the validated current view",
  );

  for (const action of [
    "dismissShowAction",
    "restoreShowAction",
    "setInterestedAction",
  ]) {
    const source = actionSource(action);
    assert.match(source, /workflowReturnPath\(formData\.get\("returnTo"\)\)/);
    assert.match(source, /refreshWorkflowViews\(returnTo/);
  }
});

test("show dismissal actions support grouped festivals and refresh festival views", () => {
  const dismiss = actionSource("dismissShowAction");
  const restore = actionSource("restoreShowAction");

  for (const source of [dismiss, restore]) {
    assert.match(source, /formData\s*\.getAll\("showId"\)/);
    assert.match(source, /db\.show\.updateMany/);
    assert.match(source, /refreshWorkflowViews\(returnTo, \["\/festivals"\]\)/);
  }
  assert.match(dismiss, /dismissedAt: new Date\(\)/);
  assert.match(restore, /dismissedAt: null/);
});

test("follow-up action derives identity from the parent and preserves workflow return state", () => {
  const followUp = actionSource("sendFollowUpAction");
  assert.match(
    followUp,
    /workflowReturnPath\(formData\.get\("returnTo"\)\)/,
  );
  assert.match(followUp, /formData\.get\("parentOutreachId"\)/);
  assert.doesNotMatch(followUp, /formData\.get\("(showId|contactId)"\)/);
  assert.match(followUp, /isWeekendET\(\)/);
  assert.match(followUp, /scheduleFollowUp\(parentOutreachId/);
  assert.match(followUp, /sendFollowUp\(parentOutreachId\)/);
  assert.match(followUp, /refreshWorkflowViews\(returnTo/);
  assert.ok(
    followUp.indexOf("refreshWorkflowViews(returnTo") <
      followUp.indexOf("result.scheduled"),
  );
  assert.match(
    followUp,
    /result\.scheduled \? "followup_scheduled" : "followup_sent"/,
  );

  assert.match(followUpButtonSource, /name="parentOutreachId"/);
  assert.match(followUpButtonSource, /pendingLabel=/);
  assert.match(followUpButtonSource, /Send follow-up/);
  assert.match(followUpButtonSource, /Schedule follow-up/);
  assert.match(followUpButtonSource, /Follow-up sent/);
  assert.match(followUpButtonSource, /Follow-up unavailable/);
});
