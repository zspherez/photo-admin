import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("contact audit UI is an unresolved flagged exception queue", () => {
  assert.match(source, /status: "complete"/);
  assert.match(source, /finding: \{ in: \[\.\.\.FLAGGED_FINDINGS\] \}/);
  assert.match(source, /resolution: null/);
  assert.match(source, /Decisions needed/);
  assert.doesNotMatch(source, /type AuditView/);
  assert.doesNotMatch(source, /Unreviewed/);
  assert.doesNotMatch(source, /All \(/);
  assert.doesNotMatch(source, /edit a contact separately/i);
});

test("contact audit UI exposes evidence and in-place decisions", () => {
  assert.match(source, /Queue full contact audit/);
  assert.match(source, /Full audit queued/);
  assert.match(source, /Full audit running/);
  assert.match(source, /Workflow diagnostics/);
  assert.match(source, /polls every 10 minutes/);
  assert.match(source, /requestedAt/);
  assert.match(source, /startedAt/);
  assert.match(source, /completedAt/);
  assert.match(source, /lastAttemptAt/);
  assert.match(source, /Exact contact under review/);
  assert.match(source, /Complete snapshotted artist roster/);
  assert.match(source, /Legacy\/incomplete contact context/);
  assert.match(source, /Audited target/);
  assert.match(source, /Already stored contact/);
  assert.match(source, /current status:/);
  assert.match(source, /Saved evidence/);
  assert.match(source, /Verification source/);
  assert.match(source, /Alternative source/);
  assert.match(source, /New proposed manager contacts/);
  assert.match(source, /not contacts\s+already stored in the roster/);
  assert.match(source, /ambiguity is\s+among already stored roster contacts/);
  assert.match(source, /Approve and apply this contact/);
  assert.match(source, /Approve stale — mark contact inactive/);
  assert.match(source, /Reject finding — keep current contact active/);
  assert.match(source, /pendingLabel="Applying contact…"/);
  assert.match(source, /role="alert"/);
});

test("every contact audit Server Action authenticates and resolves in place", () => {
  const actions = [
    source.slice(
      source.indexOf("async function queueContactAuditAction"),
      source.indexOf("async function approveContactAuditAction")
    ),
    source.slice(
      source.indexOf("async function approveContactAuditAction"),
      source.indexOf("async function rejectContactAuditAction")
    ),
    source.slice(
      source.indexOf("async function rejectContactAuditAction"),
      source.indexOf("export default async function ContactAuditPage")
    ),
  ];
  for (const action of actions) {
    assert.match(action, /"use server"/);
    assert.match(action, /requireServerActionAuth\("\/contact-audit"\)/);
    assert.match(action, /revalidatePath\("\/contact-audit"\)/);
  }
  assert.match(actions[0], /requestContactAudit/);
  assert.match(actions[1], /resolveContactAuditJob/);
  assert.match(actions[2], /resolveContactAuditJob/);
});
