import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertReleaseCompatibility,
  ReleaseCompatibilityError,
} from "./releaseCompatibility";

test("schema compatibility can be verified before Sheet ownership cutover", () => {
  assert.doesNotThrow(() =>
    assertReleaseCompatibility(
      {
        databaseProbeSucceeded: true,
        configuredSpreadsheetId: null,
        configuredSheetTab: null,
        activeUnownedSheetContacts: 4,
      },
      false
    )
  );
});

test("post-adoption compatibility requires a complete target and no active unowned Sheet contacts", () => {
  assert.doesNotThrow(() =>
    assertReleaseCompatibility(
      {
        databaseProbeSucceeded: true,
        configuredSpreadsheetId: "sheet-123",
        configuredSheetTab: "Artists",
        activeUnownedSheetContacts: 0,
      },
      true
    )
  );
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: true,
          configuredSpreadsheetId: "sheet-123",
          configuredSheetTab: null,
          activeUnownedSheetContacts: 0,
        },
        true
      ),
    ReleaseCompatibilityError
  );
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: true,
          configuredSpreadsheetId: "sheet-123",
          configuredSheetTab: "Artists",
          activeUnownedSheetContacts: 1,
        },
        true
      ),
    /Active legacy Sheet contacts/
  );
});

test("required schema probes fail closed", () => {
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: false,
          configuredSpreadsheetId: null,
          configuredSheetTab: null,
          activeUnownedSheetContacts: 0,
        },
        false
      ),
    /required schema surface/
  );
});

test("release probe exercises all release-critical runtime schema surfaces", () => {
  const source = readFileSync(
    new URL("../scripts/verify-release-compatibility.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /db\.show\.count\(\{[\s\S]*countryCode: "US"[\s\S]*countryName: \{ not: null \}/,
  );
  assert.match(
    source,
    /db\.outreach\.count\(\{\s*where: \{ kind: "original", parentOutreachId: null \}/,
  );
  assert.match(
    source,
    /contactProbe,\s*directOutreachNoteProbe,\s*festivalGeographyProbe,\s*outreachKindProbe,\s*outreachAttemptProbe/,
  );
  assert.match(source, /directOutreachNote: \{ not: null \}/);
  assert.match(
    source,
    /db\.contactResearchJob\.findMany\(\{[\s\S]*claimedAgentRules: true,[\s\S]*claimedAgentRulesVersion: true/,
  );
  assert.doesNotMatch(source, /db\.contactResearchJob\.count/);
  assert.match(
    source,
    /db\.contactResearchCandidate\.findMany\(\{[\s\S]*needsApproval: true,[\s\S]*officialSourceType: true,[\s\S]*officialSourceUrl: true,[\s\S]*officialManagementLabel: true,[\s\S]*officialSourceEvidence: true/,
  );
  assert.doesNotMatch(source, /db\.contactResearchCandidate\.count/);
  assert.match(
    source,
    /db\.artistResearchSkip\.findMany\(\{[\s\S]*artistId: true,[\s\S]*source: true,[\s\S]*reason: true,[\s\S]*sourceJobId: true,[\s\S]*agentRuleVersion: true,[\s\S]*agentRuleText: true,[\s\S]*clearedAt: true/,
  );
  assert.doesNotMatch(source, /db\.artistResearchSkip\.count/);
  assert.match(
    source,
    /db\.agentRuleSet\.findMany\(\{[\s\S]*scope: true,[\s\S]*instructions: true,[\s\S]*version: true,[\s\S]*createdAt: true,[\s\S]*updatedAt: true/,
  );
  assert.match(
    source,
    /\[\s*contactResearchJobProbe,\s*contactResearchCandidateProbe,\s*artistResearchSkipProbe,\s*agentRuleSetProbe,\s*contactAuditRunProbe,\s*contactAuditJobProbe,\s*contactAuditAlternativeProbe,\s*\]\.every\(Array\.isArray\)/,
  );
  assert.match(
    source,
    /db\.edmtrainVenue\.count\(\{[\s\S]*nycStatus: \{ in: \["inside_nyc", "outside_nyc", "unknown"\] \}/
  );
  assert.match(
    source,
    /db\.contactAuditRun\.findMany\(\{[\s\S]*status: true,[\s\S]*contactCount: true,[\s\S]*completedAt: true,[\s\S]*createdAt: true/,
  );
  assert.match(
    source,
    /db\.contactAuditJob\.findMany\(\{[\s\S]*runId: true,[\s\S]*snapshotArtistName: true,[\s\S]*snapshotEmail: true,[\s\S]*status: true,[\s\S]*claimExpiresAt: true,[\s\S]*finding: true,[\s\S]*sourceUrls: true,[\s\S]*evidence: true,[\s\S]*confidence: true,[\s\S]*verifiedAt: true,[\s\S]*reviewedAt: true/,
  );
  assert.match(
    source,
    /db\.contactAuditAlternative\.findMany\(\{[\s\S]*jobId: true,[\s\S]*normalizedEmail: true,[\s\S]*email: true,[\s\S]*role: true,[\s\S]*sourceUrls: true,[\s\S]*evidence: true,[\s\S]*confidence: true/,
  );
  assert.match(
    source,
    /addedRuntimeRoleProbes: \[\s*"ArtistResearchSkip",\s*"ContactAuditRun",\s*"ContactAuditJob",\s*"ContactAuditAlternative",\s*\]/,
  );
});
