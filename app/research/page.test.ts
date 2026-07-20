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
    "skipArtistAction"
  );

  assert.match(approve, /if \(!result\.ok\)[\s\S]*redirect/);
  assert.match(approve, /if \(result\.sheetError\)[\s\S]*redirect/);
  assert.doesNotMatch(approve, /approved: "1"/);
  assert.match(reject, /if \(!result\.ok\) \{[\s\S]*redirect/);
  assert.doesNotMatch(reject, /rejected: "1"/);
  assert.match(retry, /if \(!retried\) \{[\s\S]*redirect/);
  assert.doesNotMatch(retry, /retried: "1"/);
  assert.match(notes, /if \(!updated\) \{[\s\S]*redirect/);
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

test("intentional skips have a URL-backed count and dedicated view", () => {
  assert.match(source, /parseContactResearchView\(raw\.view\)/);
  assert.match(source, /db\.artistResearchSkip\.count/);
  assert.match(source, /contactResearchHref\("skipped"\)/);
  assert.match(source, /aria-current=\{researchView === "skipped"/);
  assert.match(source, />Skipped</);
  assert.match(source, /← All research jobs/);
  assert.match(
    source,
    /researchView === "skipped"[\s\S]*job\."status" = 'skipped'/
  );
});

test("research cards support explicit skip and unskip with audit context", () => {
  assert.match(source, /skipContactResearchArtist/);
  assert.match(source, /unskipContactResearchArtist/);
  assert.match(source, /label="Intentional skip reason"/);
  assert.match(source, /required/);
  assert.match(source, /Intentionally skip artist/);
  assert.match(source, /Unskip and restore eligibility/);
  assert.match(source, /Intentionally skipped/);
  assert.match(source, /activeSkip\.reason/);
  assert.match(source, /trusted global rules version/);
  assert.match(source, /Rule: \{activeSkip\.agentRuleText\}/);
});

test("research mutations preserve the skipped view URL", () => {
  assert.match(source, /contactResearchViewFromForm\(formData\)/);
  assert.match(
    source,
    /name="view"\s*value=\{researchView\}/
  );
  assert.match(
    source,
    /contactResearchHref\(view, \{ error: "skip_failed" \}\)/
  );
});

test("research status banners clear after three seconds without navigation", () => {
  assert.match(dismissSource, /}, 3_000\)/);
  assert.match(dismissSource, /window\.history\.replaceState/);
  assert.doesNotMatch(dismissSource, /router\.(push|replace)/);
  assert.match(source, /<AutoDismissStatus>/);
});
