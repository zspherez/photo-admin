import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./page.tsx", import.meta.url),
  "utf8"
);

function actionSource(name: string, nextName: string): string {
  return source.slice(
    source.indexOf(`async function ${name}`),
    source.indexOf(`async function ${nextName}`)
  );
}

test("successful research actions revalidate without redirecting to the top", () => {
  const approve = actionSource(
    "approveCandidateAction",
    "rejectCandidateAction"
  );
  const reject = actionSource(
    "rejectCandidateAction",
    "retryJobAction"
  );
  const retry = actionSource("retryJobAction", "saveResearchNotesAction");
  const notes = actionSource(
    "saveResearchNotesAction",
    "statusTone"
  );

  assert.match(approve, /if \(!result\.ok\)[\s\S]*redirect/);
  assert.match(approve, /if \(result\.sheetError\)[\s\S]*redirect/);
  assert.doesNotMatch(approve, /approved: "1"/);
  assert.match(reject, /if \(!result\.ok\) redirect/);
  assert.doesNotMatch(reject, /rejected: "1"/);
  assert.match(retry, /if \(!retried\) redirect/);
  assert.doesNotMatch(retry, /retried: "1"/);
  assert.match(notes, /if \(!updated\) redirect/);
  assert.doesNotMatch(notes, /notes_saved: "1"/);
});
