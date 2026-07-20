import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  contactResearchHref,
  parseContactResearchView,
} from "./contactResearchView";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260720053000_intentional_artist_skip/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const resultRoute = readFileSync(
  new URL(
    "../app/api/contact-research/[jobId]/result/route.ts",
    import.meta.url
  ),
  "utf8"
);

test("intentional skip migration is transactional and constrained", () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /'inactive',\s*'skipped'/);
  assert.match(
    migration,
    /ArtistResearchSkip_reason_check[\s\S]*char_length\(btrim\("reason"\)\) BETWEEN 1 AND 4000/
  );
  assert.match(
    migration,
    /ArtistResearchSkip_agent_provenance_check[\s\S]*"source" = 'manual'[\s\S]*"source" = 'agent'[\s\S]*"agentRuleVersion" >= 1[\s\S]*char_length\(btrim\("agentRuleText"\)\) BETWEEN 1 AND 8000/
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "ArtistResearchSkip_active_artist_key"[\s\S]*WHERE "clearedAt" IS NULL/
  );
  assert.match(
    migration,
    /ArtistResearchSkip_clear_audit_check[\s\S]*"clearedBy" = 'manual'/
  );
  assert.match(
    migration,
    /CREATE FUNCTION "guard_artist_research_skip_update"\(\)[\s\S]*NEW\."artistId" IS DISTINCT FROM OLD\."artistId"[\s\S]*NEW\."source" IS DISTINCT FROM OLD\."source"[\s\S]*NEW\."reason" IS DISTINCT FROM OLD\."reason"[\s\S]*NEW\."sourceJobId" IS DISTINCT FROM OLD\."sourceJobId"[\s\S]*NEW\."agentRuleVersion" IS DISTINCT FROM OLD\."agentRuleVersion"[\s\S]*NEW\."agentRuleText" IS DISTINCT FROM OLD\."agentRuleText"[\s\S]*NEW\."setAt" IS DISTINCT FROM OLD\."setAt"/
  );
  assert.match(
    migration,
    /IF OLD\."clearedAt" IS NOT NULL THEN[\s\S]*Cleared ArtistResearchSkip audit rows are immutable/
  );
  assert.match(
    migration,
    /NEW\."clearedAt" IS NULL[\s\S]*NEW\."clearedBy" IS DISTINCT FROM 'manual'[\s\S]*permits only a one-way valid manual clear/
  );
  assert.match(
    migration,
    /CREATE TRIGGER "ArtistResearchSkip_immutable_audit"[\s\S]*BEFORE UPDATE ON "ArtistResearchSkip"/
  );
});

test("invalid rule provenance is rejected without being treated as stale", () => {
  assert.match(
    resultRoute,
    /result\.status === "invalid_rule_provenance"[\s\S]*status: 400/
  );
  assert.match(
    resultRoute,
    /claim is stale or no longer owned[\s\S]*status: 409/
  );
});

test("skipped view URLs are explicit and fail closed to all", () => {
  assert.equal(parseContactResearchView("skipped"), "skipped");
  assert.equal(parseContactResearchView(["skipped", "all"]), "skipped");
  assert.equal(parseContactResearchView("unknown"), "all");
  assert.equal(contactResearchHref("all"), "/research");
  assert.equal(
    contactResearchHref("skipped", { error: "skip_failed" }),
    "/research?error=skip_failed&view=skipped"
  );
});
