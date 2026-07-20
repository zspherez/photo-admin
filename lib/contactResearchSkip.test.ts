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
