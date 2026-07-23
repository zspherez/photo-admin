import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("contact audit UI groups unresolved findings once per artist", () => {
  assert.match(source, /status: "complete"/);
  assert.match(source, /finding: \{ in: \[\.\.\.FLAGGED_FINDINGS\] \}/);
  assert.match(source, /resolution: null/);
  assert.match(source, /groupsByArtist/);
  assert.match(source, /incompleteArtistIds/);
  assert.match(source, /status: \{ not: "complete" \}/);
  assert.match(source, /Artists needing decisions/);
  assert.match(source, /Each artist appears once/);
  assert.doesNotMatch(source, /type AuditView/);
  assert.doesNotMatch(source, /Unreviewed/);
  assert.doesNotMatch(source, /All \(/);
});

test("contact audit UI exposes the full roster and artist-level decisions", () => {
  assert.match(source, /Queue full contact audit/);
  assert.match(source, /Full audit queued/);
  assert.match(source, /Full audit running/);
  assert.match(source, /Workflow diagnostics/);
  assert.match(source, /polls every 10 minutes/);
  assert.match(source, /requestedAt/);
  assert.match(source, /startedAt/);
  assert.match(source, /completedAt/);
  assert.match(source, /lastAttemptAt/);
  assert.match(source, /Complete artist contact roster/);
  assert.match(source, /current status:/);
  assert.match(source, /Audit evidence for/);
  assert.match(source, /Proposed manager contacts/);
  assert.match(source, /Add contact and keep all existing/);
  assert.match(source, /Replace selected contacts/);
  assert.match(source, /Add new and deactivate selected/);
  assert.match(source, /Deactivate selected stale contacts/);
  assert.match(source, /staleEntries\.length > 0/);
  assert.match(source, /\{staleEntries\.map/);
  assert.match(source, /Reject proposed change — keep all contacts/);
  assert.match(source, /name="selectedContactId"/);
  assert.match(source, /role="alert"/);
});

test("every contact audit Server Action authenticates and resolves in place", () => {
  const actions = [
    source.slice(
      source.indexOf("async function queueContactAuditAction"),
      source.indexOf("async function saveArtistAuditDecisionAction")
    ),
    source.slice(
      source.indexOf("async function saveArtistAuditDecisionAction"),
      source.indexOf("export default async function ContactAuditPage")
    ),
  ];
  for (const action of actions) {
    assert.match(action, /"use server"/);
    assert.match(action, /requireServerActionAuth\("\/contact-audit"\)/);
    assert.match(action, /revalidatePath\("\/contact-audit"\)/);
  }
  assert.match(actions[0], /requestContactAudit/);
  assert.match(actions[1], /resolveContactAuditArtist/);
  assert.match(actions[1], /getAll\("selectedContactId"\)/);
});
