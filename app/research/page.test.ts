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

test("research page links to the trusted queue-draining workflow", () => {
  assert.match(
    source,
    /actions\/workflows\/contact-research\.yml/
  );
  assert.match(source, /Run queued research/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test("research jobs are ranked by the best upcoming venue tier", () => {
  assert.match(source, /venueTierSql/);
  assert.match(source, /LEFT JOIN LATERAL/);
  assert.match(source, /ORDER BY "tier" DESC, show\."date" ASC/);
  assert.match(
    source,
    /activeFilter === "all"[\s\S]*CASE WHEN job\."status" = 'exhausted' THEN 1 ELSE 0 END,[\s\S]*COALESCE\(best_show\."tier", 0\) DESC/
  );
  assert.match(source, /LIMIT 125/);
  assert.match(source, /venueTierLabel\(job\.bestShow\.tier\)/);
  assert.match(
    source,
    /show\."syncStatus" = 'active'[\s\S]*festivalLeadTimeSql\(now\)/
  );
});

test("status filtering happens before ordering and limiting while counts stay global", () => {
  assert.match(
    source,
    /groupBy\(\{[\s\S]*where: \{ status: \{ in: \[\.\.\.RESEARCH_JOB_STATUSES\] \} \}[\s\S]*_count/
  );
  assert.match(
    source,
    /job\."status" IN \(\$\{Prisma\.join\([\s\S]*activeFilterDefinition\.statuses[\s\S]*\)\}\)/
  );
  assert.match(
    source,
    /WHERE \$\{visibleStatusWhere\}[\s\S]*ORDER BY[\s\S]*LIMIT 125/
  );
  assert.match(source, /counts\.set\("skipped", skippedCount\)/);
});

test("status count cards are accessible links with a visible active state", () => {
  assert.match(
    source,
    /aria-label="Filter contact research jobs by status"/
  );
  assert.match(source, /RESEARCH_STATUS_FILTERS\.map/);
  assert.match(source, /href=\{researchStatusHref\(filter\.key\)\}/);
  assert.match(source, /aria-current=\{isActive \? "page" : undefined\}/);
  assert.match(source, /isActive[\s\S]*border-zinc-900 ring-1 ring-zinc-900/);
});

test("review and exhausted jobs can be requeued", () => {
  assert.match(
    source,
    /job\.status === "exhausted" \|\|\s*job\.status === "review"/
  );
  assert.match(source, />\s*Requeue research\s*</);
});

test("intentional skips have a URL-backed count and dedicated view", () => {
  assert.match(source, /parseResearchStatusFilter\(raw\.status\)/);
  assert.match(source, /parseContactResearchView\(raw\.view\)/);
  assert.match(source, /db\.artistResearchSkip\.count/);
  assert.match(source, /activeFilter === "skipped"/);
  assert.match(source, /RESEARCH_STATUS_FILTERS\.map/);
  assert.match(
    source,
    /activeFilter === "skipped"[\s\S]*job\."status" = 'skipped'[\s\S]*ArtistResearchSkip/
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

test("research actions preserve the active status URL", () => {
  assert.match(
    source,
    /function actionResearchFilter\(formData: FormData\)[\s\S]*formData\.get\("status"\)/
  );
  assert.match(
    source,
    /researchStatusHref\(filter, \{ error: "skip_failed" \}\)/
  );
  assert.match(
    source,
    /researchStatusHref\(filter, \{ error: "unskip_failed" \}\)/
  );
  assert.ok(
    (source.match(
      /<input[\s\S]{0,120}type="hidden"[\s\S]{0,120}name="status"[\s\S]{0,120}value=\{activeFilter\}/g
    )?.length ?? 0) >= 9,
    "expected every research action form to submit the active status filter"
  );
});

test("research status banners clear after three seconds without navigation", () => {
  assert.match(dismissSource, /}, 3_000\)/);
  assert.match(dismissSource, /window\.history\.replaceState/);
  assert.doesNotMatch(dismissSource, /router\.(push|replace)/);
  assert.doesNotMatch(dismissSource, /"status"/);
  assert.match(source, /<AutoDismissStatus>/);
});
