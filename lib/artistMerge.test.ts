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
  assert.match(source, /Both artists have manager-research jobs/);
  assert.match(source, /same contact-audit run/);
  assert.match(source, /outreach send is currently in progress/);
  assert.match(source, /contact-audit job is currently claimed/);
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
