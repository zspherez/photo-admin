import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("./route.ts", import.meta.url),
  "utf8"
);
const research = readFileSync(
  new URL("../../../../../lib/contactResearch.ts", import.meta.url),
  "utf8"
);
const migration = readFileSync(
  new URL(
    "../../../../../prisma/migrations/20260720050000_contact_research_official_sources/migration.sql",
    import.meta.url
  ),
  "utf8"
);

test("result route returns atomic official-source auto-approval results", () => {
  assert.doesNotMatch(route, /approveContactResearchCandidates/);
  assert.match(route, /result\.autoApproved/);
  assert.match(route, /result\.sheetErrors/);
  assert.match(research, /isOfficialManagementAutoApprovalEligible/);
  assert.match(research, /candidate\.needsApproval === false/);
  assert.match(research, /officialSourceEvidence !== null/);
  assert.match(
    research,
    /autoApproveCandidates\.length > 0[\s\S]*tx\.contact\.create[\s\S]*status: "complete"/
  );
  assert.match(research, /approveContactResearchCandidates/);
});

test("official-source migration requires complete audited provenance", () => {
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /official_source_complete_check/);
  assert.match(migration, /auto_approval_evidence_check/);
  assert.match(
    migration,
    /'website'[\s\S]*'instagram'[\s\S]*'facebook'[\s\S]*'soundcloud'/
  );
  assert.match(migration, /COMMIT;/);
});
