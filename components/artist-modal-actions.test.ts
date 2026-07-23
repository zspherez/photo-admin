import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const modalSource = readFileSync(
  new URL("./artist-modal.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/artists/[id]/route.ts", import.meta.url),
  "utf8",
);

test("artist modal shows the existing send, queue, customize, and follow-up actions", () => {
  assert.match(modalSource, /<SendButton/);
  assert.match(modalSource, /action=\{sendNowAction\}/);
  assert.match(modalSource, /cancelAction=\{cancelScheduledAction\}/);
  assert.match(modalSource, /<QueueOutreachButton/);
  assert.match(modalSource, /action=\{queueForNextDispatchAction\}/);
  assert.match(modalSource, />\s*Customize\s*</);
  assert.match(modalSource, /<FollowUpButton/);
  assert.match(modalSource, /action=\{sendFollowUpAction\}/);
  assert.match(modalSource, /emailContactsRequireSelection\(data\.contacts\)/);
});

test("artist modal API supplies policy-derived action state for every show", () => {
  assert.match(routeSource, /getOutreachSendabilityBatch/);
  assert.match(routeSource, /getFollowUpEligibilityBatch/);
  assert.match(routeSource, /getNextNormalOutreachDispatch/);
  assert.match(routeSource, /actionContacts:/);
  assert.match(routeSource, /alreadySent:/);
  assert.match(routeSource, /\bscheduledInfo,\s*sendability:/);
  assert.match(routeSource, /sendability:/);
  assert.match(routeSource, /followUpEligibility:/);
});
