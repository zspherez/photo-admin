import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("bounced resend review authenticates, confirms the snapshot and redirects to Customize without sending", () => {
  const source = readFileSync(new URL("./outreach/[outreachId]/resend/page.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("async function prepareResend"), source.indexOf("export default"));
  assert.ok(action.indexOf("await requireServerActionAuth") < action.indexOf("await resetBouncedOutreachForResend"));
  assert.match(action, /formData\.get\("confirmed"\) !== "yes"/);
  assert.match(action, /expectedIdempotencyKey/);
  assert.match(action, /allowReleasedRecipients: true/);
  assert.match(action, /if \(!result\.ok\) redirect/);
  assert.match(action, /query\.set\("parentOutreachId", outreach\.parentOutreachId\)/);
  assert.match(action, /redirect\(`\/dashboard\/customize/);
  assert.doesNotMatch(action, /\b(sendOutreach|scheduleOutreach|sendFollowUp|scheduleFollowUp)\(/);
  assert.match(source, /disabled=\{access !== "admin"/);
  const history = readFileSync(new URL("./outreach/page.tsx", import.meta.url), "utf8");
  assert.match(history, /bouncedAt: true/);
  assert.match(history, /o\.status === "failed" && o\.bouncedAt/);
  assert.match(history, /Review &amp; resend/);
});
