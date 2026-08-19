import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./artistMerge.ts", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../app/artists/merge/page.tsx", import.meta.url),
  "utf8",
);
const detail = readFileSync(
  new URL("../app/artists/[id]/page.tsx", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819190000_artist_merge_ui/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("artist merge UI requires an explicit canonical choice and confirmation", () => {
  assert.match(detail, /Review merge/);
  assert.match(page, /Keep \{artistDisplayName\(preview\.target\)\}/);
  assert.match(page, /name="confirmation"/);
  assert.match(page, /value="MERGE"/);
  assert.match(page, /Merge into \{artistDisplayName\(preview\.target\)\}/);
  assert.match(page, /preview\.blockers/);
  assert.match(page, /name="researchJobPolicy"/);
  assert.match(page, /Choose the manager-research job to keep/);
  assert.match(page, /Unique candidates, direct-outreach proposals, notes/);
});

test("artist merge is serialized, audited, and covers every Artist relation", () => {
  assert.match(source, /acquireArtistIdentityLock\(tx\)/);
  assert.match(source, /acquireShowArtistMembershipLock\(tx\)/);
  assert.match(
    source,
    /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/,
  );
  for (const model of [
    "showArtist",
    "listenSignal",
    "artistPlaylist",
    "outreachCoveredArtist",
    "contact",
    "outreach",
    "contactAuditRequest",
    "contactAuditJob",
    "contactAuditArtistDecision",
    "artistResearchSkip",
    "trajectoryRunArtist",
    "contactResearchJob",
    "contactResearchCandidate",
    "contactResearchDirectOutreachProposal",
    "artistExternalIdentityAlias",
    "artistMergeEvent",
  ]) {
    assert.match(source, new RegExp(`tx\\.${model}`), model);
  }
  assert.ok(
    source.indexOf("tx.artistMergeEvent.create") <
      source.indexOf("tx.artist.delete"),
  );
});

test("merge blockers fail closed for ambiguous dependent records", () => {
  assert.match(source, /same contact email/);
  assert.match(source, /same contact-audit run/);
  assert.match(source, /outreach send is currently in progress/);
  assert.match(source, /contact-audit job is currently claimed/);
  assert.match(source, /manager-research claim/);
});

test("manager-research job conflicts are resolved inside the merge", () => {
  assert.match(source, /type ArtistMergeResearchJobPolicy = "target" \| "source"/);
  assert.match(source, /async function mergeResearchJobs/);
  assert.match(source, /Choose which manager-research job to keep/);
  assert.match(source, /mergeResearchCandidates/);
  assert.match(source, /mergeResearchProposals/);
  assert.match(source, /Merged duplicate status:/);
  assert.match(source, /status: "pending"/);
  assert.match(source, /const mergedStatus =/);
  assert.match(source, /pendingCandidates > 0 \|\| pendingProposals > 0/);
  assert.match(source, /\? "review"/);
  assert.match(source, /sourceJobId: loser\.id/);
  assert.match(
    source,
    /tx\.contactResearchJob\.delete\(\{ where: \{ id: loser\.id \} \}\);[\s\S]*tx\.contactResearchJob\.update\(\{\s*where: \{ id: winner\.id \}/,
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("async function previewBlockers"),
      source.indexOf("function moveCounts"),
    ),
    /Both artists have manager-research jobs/,
  );
});

test("artist merge migrations retain provider aliases and immutable audit", () => {
  assert.match(migration, /^BEGIN;\n/);
  assert.match(migration, /CREATE TABLE "ArtistExternalIdentityAlias"/);
  assert.match(migration, /UNIQUE INDEX "ArtistExternalIdentityAlias_provider_externalId_key"/);
  assert.match(migration, /CREATE TABLE "ArtistMergeEvent"/);
  assert.match(migration, /ArtistMergeEvent_distinct_artists_check/);
  assert.match(migration, /ArtistMergeEvent_immutable_update/);
  assert.match(migration, /ArtistMergeEvent_immutable_delete/);
  assert.match(migration, /\nCOMMIT;\s*$/);
});
