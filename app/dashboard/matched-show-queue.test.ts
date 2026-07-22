import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const actions = source("app/dashboard/actions.ts");
const client = source("app/dashboard/dashboard-client.tsx");
const page = source("app/dashboard/page.tsx");
const queueButton = source("components/queue-outreach-button.tsx");
const sendButton = source("components/send-button.tsx");
const sendOutreach = source("lib/sendOutreach.ts");
const customizePage = source(
  "app/dashboard/customize/[showId]/[contactId]/page.tsx",
);
const customizeForm = source(
  "app/dashboard/customize/[showId]/[contactId]/customize-form.tsx",
);

function actionSource(name: string): string {
  const start = actions.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = actions.indexOf("\nexport async function ", start + 1);
  return actions.slice(start, next === -1 ? undefined : next);
}

test("sendable matched cards expose the shared next-dispatch action only for new outreach", () => {
  assert.match(page, /formatNextDispatchActionLabel\(/);
  assert.match(page, /getNextNormalOutreachDispatch\(now\)/);
  assert.match(client, /const queueEligible =[\s\S]*artist\.workflowEligible/);
  assert.match(client, /!!emailContact/);
  assert.match(client, /sendability\?\.sendable === true/);
  assert.match(client, /sendability\.mode === "new"/);
  assert.match(
    client,
    /\{queueEligible && emailContact && \([\s\S]*<QueueOutreachButton/,
  );
  assert.match(queueButton, /\{queueLabel\}/);
  assert.match(queueButton, /pendingLabel="Queueing…"/);
});

test("ambiguous manager contacts route to Customize with explicit queue intent", () => {
  assert.match(client, /emailContactsRequireSelection\(artist\.contacts\)/);
  assert.match(
    client,
    /\/dashboard\/customize\/\$\{show\.id\}\/\$\{emailContact\.id\}\?intent=queue/,
  );

  const queue = actionSource("queueForNextDispatchAction");
  assert.match(queue, /pickEmailContact\(artistContacts\)/);
  assert.match(queue, /defaultContact\.id !== contact\.id/);
  assert.match(queue, /emailContactsRequireSelection\(artistContacts\)/);
  assert.match(queue, /\?intent=queue/);
  assert.ok(
    queue.indexOf("emailContactsRequireSelection") <
      queue.indexOf("scheduleOutreach"),
  );

  assert.match(customizePage, /search\.intent/);
  assert.match(
    customizePage,
    /initialIntent === "queue" \? "queue" : "send"/,
  );
  assert.match(customizeForm, /initialIntent === "queue"/);
  assert.match(
    customizeForm,
    /Choose the intended recipient,[\s\S]*next normal dispatch/,
  );
});

test("dashboard queue action authenticates, preserves return state, and never sends immediately", () => {
  const queue = actionSource("queueForNextDispatchAction");
  assert.match(queue, /requireServerActionAuth/);
  assert.match(queue, /workflowReturnPath\(formData\.get\("returnTo"\)\)/);
  assert.match(
    queue,
    /scheduleOutreach\([\s\S]*getNextNormalOutreachDispatch\(\)/,
  );
  assert.doesNotMatch(queue, /sendOutreach\(/);
  assert.match(queue, /refreshWorkflowViews\(returnTo/);
  assert.match(queue, /festivalReturnPath\(showId\)/);
  assert.match(queue, /dashboardResultHref\([\s\S]*"queued"/);
  assert.match(queueButton, /name="returnTo"/);
  assert.match(queueButton, /name="showId"/);
  assert.match(queueButton, /name="contactId"/);
});

test("queue reuses immutable template scheduling, duplicate protection, and dispatch safety", () => {
  assert.match(
    sendOutreach,
    /export async function scheduleOutreach\([\s\S]*prepareOriginalOutreach\(input\)[\s\S]*schedulePreparedOutreach/,
  );
  assert.match(sendOutreach, /ensureOriginalTemplateForShow\(show\)/);
  assert.match(sendOutreach, /preparedTemplatePurposeBlockingReason/);

  const scheduled = sendOutreach.slice(
    sendOutreach.indexOf("async function schedulePreparedOutreach"),
    sendOutreach.indexOf("export async function scheduleOutreach"),
  );
  assert.match(scheduled, /scheduled\.contactId === prep\.contactId/);
  assert.match(scheduled, /scheduled\.finalSubject === prep\.subject/);
  assert.match(scheduled, /scheduled\.finalHtml === prep\.html/);
  assert.match(scheduled, /scheduled\.fullTeamSend === prep\.fullTeamSend/);
  assert.match(scheduled, /sameEmails\(scheduled\.recipientEmails, prep\.recipients\)/);
  assert.match(scheduled, /recipientSnapshotState: "verified"/);
  assert.match(scheduled, /scheduledFor/);
  assert.match(scheduled, /idempotencyKey/);
});

test("queued state disables duplicate queue and keeps confirmation and cancellation visible", () => {
  assert.match(client, /sendability\.mode === "new"/);
  assert.match(client, /blockingStatus === "queued"[\s\S]*"In progress"/);
  assert.match(client, /isCancellableOutreachStatus/);
  assert.match(sendButton, /scheduledInfo/);
  assert.match(sendButton, /cancelAction/);
  assert.match(sendButton, /pendingLabel="Cancelling…"/);
  assert.match(page, /Email queued for \{queued\} ET/);
  assert.match(page, /You can cancel it from the listing/);
});

test("immediate Send behavior and All NYC workflow gating remain unchanged", () => {
  const sendNow = actionSource("sendNowAction");
  assert.match(sendNow, /if \(isWeekendET\(\)\)/);
  assert.match(sendNow, /sendOutreach\(\{/);
  assert.doesNotMatch(sendNow, /getNextNormalOutreachDispatch/);
  assert.match(
    client,
    /artist\.workflowEligible &&[\s\S]*<SendButton/,
  );
  assert.match(
    client,
    /const queueEligible =[\s\S]*artist\.workflowEligible/,
  );
});
