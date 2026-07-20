import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./page.tsx", import.meta.url),
  "utf8"
);
const dismissSource = readFileSync(
  new URL("./auto-dismiss-status.tsx", import.meta.url),
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
    "retryAllExhaustedJobsAction"
  );
  const retryExhausted = actionSource(
    "retryAllExhaustedJobsAction",
    "retryAllReviewJobsAction"
  );
  const retryReview = actionSource(
    "retryAllReviewJobsAction",
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
  assert.match(retryExhausted, /retryAllExhaustedContactResearchJobs/);
  assert.match(retryReview, /retryAllReviewContactResearchJobs/);
  assert.doesNotMatch(retryExhausted, /redirect\(/);
  assert.doesNotMatch(retryReview, /redirect\(/);
});

test("review and exhausted jobs have separate bulk requeue actions", () => {
  assert.match(source, /Requeue all review \(\{retryReviewCount\}\)/);
  assert.match(
    source,
    /Requeue exhausted \(\{retryExhaustedCount\}\)/
  );
  assert.match(source, /disabled=\{retryReviewCount === 0\}/);
  assert.match(source, /disabled=\{retryExhaustedCount === 0\}/);
});

test("research jobs are ranked by the best upcoming venue tier", () => {
  assert.match(source, /venueTierSql/);
  assert.match(source, /LEFT JOIN LATERAL/);
  assert.match(source, /ORDER BY "tier" DESC, show\."date" ASC/);
  assert.match(
    source,
    /CASE WHEN job\."status" = 'exhausted' THEN 1 ELSE 0 END,\s*COALESCE\(best_show\."tier", 0\) DESC/
  );
  assert.match(source, /LIMIT 125/);
  assert.match(source, /venueTierLabel\(job\.bestShow\.tier\)/);
});

test("review and exhausted jobs can be requeued", () => {
  assert.match(
    source,
    /job\.status === "exhausted" \|\|\s*job\.status === "review"/
  );
  assert.match(source, />\s*Requeue research\s*</);
});

test("research status banners clear after three seconds without navigation", () => {
  assert.match(dismissSource, /}, 3_000\)/);
  assert.match(dismissSource, /window\.history\.replaceState/);
  assert.doesNotMatch(dismissSource, /router\.(push|replace)/);
  assert.match(source, /<AutoDismissStatus>/);
});
