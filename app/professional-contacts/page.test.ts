import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const form = readFileSync(
  new URL("../../components/professional-contact-request-form.tsx", import.meta.url),
  "utf8",
);
const nav = readFileSync(
  new URL("../../components/nav.tsx", import.meta.url),
  "utf8",
);

test("professional contact UI confirms exact scope and shows standalone safety", () => {
  assert.match(form, /Exact submitted scope/);
  assert.match(form, /normalizeProfessionalPersonNames/);
  assert.match(form, /Confirm and queue/);
  assert.match(page, /never creates artist contacts or sends outreach/);
  assert.match(page, /public professional or business email addresses/);
  assert.match(page, /Artist manager research/);
  assert.match(nav, /p === "\/professional-contacts"/);
  assert.match(
    page,
    /createProfessionalContactRequest[\s\S]*dispatchProfessionalContactRequest/,
  );
  assert.match(page, /The trusted worker trigger was accepted/);
  assert.match(page, /Jobs will show running as soon as they are claimed/);
  assert.match(page, /ProfessionalContactAutoRefresh/);
});

test("professional contact UI exposes queue states, evidence, review, and copy", () => {
  for (const status of [
    "pending",
    "running",
    "review",
    "exhausted",
    "completed",
  ]) {
    assert.match(page, new RegExp(`"${status}"`));
  }
  assert.match(page, /Attempt \{job\.attemptCount\}/);
  assert.match(page, /Current claim lease expires/);
  assert.match(page, /candidate\.roleTitle/);
  assert.match(page, /candidate\.organization/);
  assert.match(page, /candidate\.confidence/);
  assert.match(page, /candidate\.evidence/);
  assert.match(page, /candidate\.sourceUrls\.map/);
  assert.match(page, /CopyProfessionalEmailButton/);
  assert.match(page, /Approve/);
  assert.match(page, /Reject/);
  assert.match(page, /Requeue and start research/);
  assert.match(page, /Retry worker trigger/);
  assert.match(page, /dispatchUpdatedAt/);
  assert.match(page, /worker trigger failed/);
  assert.match(page, /durable jobs remain queued/);
  assert.match(page, /no duplicate trigger was sent/);
  assert.match(page, /rel="noopener noreferrer"/);
});

test("every professional contact Server Action authenticates", () => {
  const actionNames = [
    "createRequestAction",
    "decideCandidateAction",
    "requeueJobAction",
    "retryDispatchAction",
  ];
  for (let index = 0; index < actionNames.length; index += 1) {
    const start = page.indexOf(`async function ${actionNames[index]}`);
    const end =
      index + 1 < actionNames.length
        ? page.indexOf(`async function ${actionNames[index + 1]}`)
        : page.indexOf("export default async function");
    const source = page.slice(start, end);
    assert.match(source, /"use server"/);
    assert.match(source, /requireServerActionAuth\("\/professional-contacts"\)/);
    assert.match(source, /revalidatePath\("\/professional-contacts"\)/);
  }
});
