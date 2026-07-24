import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const client = source("app/dashboard/dashboard-client.tsx");
const interactionState = source("lib/dashboardInteractionState.ts");
const sendButton = source("components/send-button.tsx");
const queueButton = source("components/queue-outreach-button.tsx");
const sendOutreach = source("lib/sendOutreach.ts");

test("All NYC active-email cards use normal sendability instead of listening eligibility", () => {
  assert.match(interactionState, /if \(!artist\.outreachEligible\) return \[\]/);
  assert.match(interactionState, /pickEmailContact\(artist\.contacts\)/);
  assert.match(
    client,
    /query\.mode === "all-nyc"[\s\S]*artist\.outreachEligible[\s\S]*isScheduled[\s\S]*sendability\?\.sendable === true[\s\S]*sendability\.mode === "new"/,
  );
  assert.match(
    client,
    /: artist\.workflowEligible &&\s*Boolean\(emailContact \|\| phoneContact\)/,
  );
});

test("All NYC cards reuse shared send, queue, customize, and cancellation controls", () => {
  assert.match(client, /<SendButton[\s\S]*action=\{sendNowAction\}/);
  assert.match(
    client,
    /<QueueOutreachButton[\s\S]*action=\{queueForNextDispatchAction\}/,
  );
  assert.match(
    client,
    /\/dashboard\/customize\/\$\{show\.id\}\/\$\{emailContact\.id\}/,
  );
  assert.match(client, /cancelAction=\{cancelScheduledAction\}/);
  assert.match(sendButton, /scheduledInfo\.scheduledLabel/);
  assert.match(sendButton, /pendingLabel="Cancelling…"/);
  assert.match(queueButton, /name="returnTo"/);
});

test("All NYC cards can record manual outreach without a listening match", () => {
  assert.match(
    client,
    /query\.mode === "all-nyc" \|\|[\s\S]*artist\.workflowEligible[\s\S]*artist\.canMarkManually[\s\S]*action=\{markSentAction\}/,
  );
  assert.match(client, />\s*Mark sent \(manual\)\s*</);
  assert.match(client, /action=\{unmarkSentAction\}/);
});

test("shared outreach pipeline retains policy, template, snapshot, and idempotency safeguards", () => {
  assert.match(sendOutreach, /evaluateOutreachDeliveryPolicy/);
  assert.match(sendOutreach, /ensureOriginalTemplateForShow\(show\)/);
  assert.match(sendOutreach, /testOverride/);
  assert.match(sendOutreach, /suppressedEmails/);
  assert.match(sendOutreach, /recipientSnapshotState: "verified"/);
  assert.match(sendOutreach, /idempotencyKey/);
});
