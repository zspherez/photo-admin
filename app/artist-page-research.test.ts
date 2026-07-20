import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./artists/[id]/page.tsx", import.meta.url),
  "utf8"
);
const controls = readFileSync(
  new URL("../components/contact-research-controls.tsx", import.meta.url),
  "utf8"
);

function actionSource(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`);
  return source.slice(
    start,
    source.indexOf(`async function ${nextName}`, start + 1)
  );
}

test("artist page loads existing research notes, job context, and current artist skip audit", () => {
  assert.match(source, /contactResearchJob: \{/);
  assert.match(source, /userNotes: true/);
  assert.match(source, /claimedAt: true/);
  assert.match(source, /claimExpiresAt: true/);
  assert.match(source, /researchSkips: \{[\s\S]*clearedAt: null/);
  assert.match(source, /userNotes=\{researchJob\?\.userNotes \?\? null\}/);
  assert.match(source, /Current research job/);
  assert.match(source, /Open research card/);
});

test("artist page uses shared notes, skip, provenance, and explicit unskip controls", () => {
  assert.match(source, /ContactResearchControls/);
  assert.match(controls, /label="Research instructions"/);
  assert.match(controls, /label="Intentional skip reason"/);
  assert.match(controls, /required/);
  assert.match(controls, /Intentionally skipped/);
  assert.match(controls, /activeSkip\.reason/);
  assert.match(controls, /trusted global rules version/);
  assert.match(controls, /Rule: \{activeSkip\.agentRuleText\}/);
  assert.match(controls, /Unskip and restore eligibility/);
});

test("artist actions authenticate internally and mutate only by their bound artist ID", () => {
  const save = actionSource(
    "saveArtistResearchNotesAction",
    "skipArtistResearchAction"
  );
  const skip = actionSource(
    "skipArtistResearchAction",
    "unskipArtistResearchAction"
  );
  const unskipStart = source.indexOf(
    "async function unskipArtistResearchAction"
  );
  const unskip = source.slice(
    unskipStart,
    source.indexOf("\n\n  return (", unskipStart)
  );
  for (const action of [save, skip, unskip]) {
    assert.match(action, /"use server"/);
    assert.match(
      action,
      /requireServerActionAuth\(\s*artistWorkflowPath\(id, formData\.get\("returnTo"\)\)\s*\)/
    );
    assert.match(action, /workflowReturnPath\(formData\.get\("returnTo"\)\)/);
    assert.doesNotMatch(action, /formData\.get\("jobId"\)/);
  }
  assert.match(save, /handleSaveArtistResearchNotes\(id, actionReturnTo, formData\)/);
  assert.match(skip, /handleSkipArtistResearch\(id, actionReturnTo, formData\)/);
  assert.match(unskip, /handleUnskipArtistResearch\(id, actionReturnTo\)/);
  assert.match(
    source,
    /handleSaveArtistResearchNotes[\s\S]*updateContactResearchArtistUserNotes\(\s*artistId/
  );
  assert.match(
    source,
    /handleSkipArtistResearch[\s\S]*skipContactResearchArtistByArtistId\(\s*artistId/
  );
  assert.match(
    source,
    /handleUnskipArtistResearch[\s\S]*unskipContactResearchArtistByArtistId\(artistId, \{[\s\S]*requestedShowId: workflowFestivalShowId\(returnTo\)/
  );
  assert.ok((source.match(/RedirectType\.replace/g)?.length ?? 0) === 3);
});

test("artist actions preserve return context and refresh artist, festival, and research views", () => {
  assert.match(source, /hiddenFields=\{\[\{ name: "returnTo", value: safeReturnTo \}\]\}/);
  assert.ok(
    (source.match(
      /refreshWorkflowViews\(returnTo, \[currentArtistPath, "\/research", "\/settings"\]\)/g
    )?.length ?? 0) === 3
  );
  assert.match(source, /workflowFestivalShowId\(returnTo\)/);
  assert.match(source, /research_saved/);
  assert.match(source, /research_skipped/);
  assert.match(source, /research_unskipped/);
  assert.match(source, /research_error/);
});

test("no-job controls document non-queueing materialization and block ineligible artists", () => {
  assert.match(
    source,
    /Saving instructions creates an[\s\S]*inactive durable record without queueing research/
  );
  assert.match(source, /hasActiveEmailContact/);
  assert.match(source, /hasEligibleRegularShow/);
  assert.match(source, /hasEligibleFestivalContext/);
  assert.match(source, /canManage=\{canManageResearch\}/);
  assert.match(source, /new manager-research job will not be created/);
  assert.match(source, /no eligible upcoming regular show or current festival context/);
  assert.match(source, /mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10/);
});
