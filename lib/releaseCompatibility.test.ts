import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertReleaseCompatibility,
  ReleaseCompatibilityError,
} from "./releaseCompatibility";

function selectedScalarFields(source: string, model: string): string[] {
  const probe = source.match(
    new RegExp(
      String.raw`db\.${model}\.findMany\(\{\s*take: 1,\s*select: \{([\s\S]*?)\s*\},\s*\}\),`,
    ),
  );
  assert.ok(probe, `${model} release probe is missing`);
  return Array.from(
    probe[1].matchAll(/^\s+([A-Za-z]\w*): true,\s*$/gm),
    (match) => match[1],
  );
}

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
    /db\.show\.count\(\{[\s\S]*countryCode: "US"[\s\S]*countryName: \{ not: null \}[\s\S]*festivalNycStatus: \{[\s\S]*inside_nyc[\s\S]*outside_nyc[\s\S]*unknown/,
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
  assert.deepEqual(
    selectedScalarFields(source, "artistResearchSkip"),
    [
      "id",
      "artistId",
      "source",
      "reason",
      "sourceJobId",
      "agentRuleVersion",
      "agentRuleText",
      "setAt",
      "clearedAt",
      "clearedBy",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.doesNotMatch(source, /db\.artistResearchSkip\.count/);
  assert.match(
    source,
    /db\.agentRuleSet\.findMany\(\{[\s\S]*scope: true,[\s\S]*instructions: true,[\s\S]*version: true,[\s\S]*createdAt: true,[\s\S]*updatedAt: true/,
  );
  assert.match(
    source,
    /\[\s*contactResearchJobProbe,\s*contactResearchCandidateProbe,\s*artistResearchSkipProbe,\s*agentRuleSetProbe,\s*contactAuditRunProbe,\s*contactAuditJobProbe,\s*contactAuditAlternativeProbe,\s*arbitraryEmailProbe,\s*resendWebhookArbitraryEmailProbe,\s*emailTemplateProbe,\s*\]\.every\(Array\.isArray\)/,
  );
  assert.match(
    source,
    /db\.edmtrainVenue\.count\(\{[\s\S]*nycStatus: \{ in: \["inside_nyc", "outside_nyc", "unknown"\] \}/
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditRun"),
    ["id", "status", "contactCount", "completedAt", "createdAt", "updatedAt"],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditJob"),
    [
      "id",
      "runId",
      "contactId",
      "artistId",
      "snapshotArtistName",
      "snapshotEmail",
      "snapshotPhone",
      "snapshotDirectOutreachNote",
      "snapshotName",
      "snapshotRole",
      "snapshotSource",
      "snapshotNotes",
      "status",
      "attemptCount",
      "claimedAt",
      "claimExpiresAt",
      "claimToken",
      "finding",
      "sourceUrls",
      "evidence",
      "confidence",
      "agentNotes",
      "verifiedAt",
      "reviewedAt",
      "resolution",
      "resolvedAt",
      "selectedAlternativeId",
      "resolvedContactId",
      "resolvedArtistId",
      "resolvedArtistName",
      "resolvedEmail",
      "resolvedPhone",
      "resolvedDirectOutreachNote",
      "resolvedName",
      "resolvedRole",
      "resolvedSource",
      "resolvedState",
      "resolutionClaimToken",
      "resolutionClaimedAt",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditAlternative"),
    [
      "id",
      "jobId",
      "normalizedEmail",
      "email",
      "name",
      "role",
      "sourceUrls",
      "evidence",
      "confidence",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "arbitraryEmail"),
    [
      "id",
      "recipientEmails",
      "subject",
      "html",
      "text",
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "utmContent",
      "utmTerm",
      "status",
      "error",
      "providerMessageId",
      "idempotencyKey",
      "providerRequest",
      "requestHash",
      "testSend",
      "sentAt",
      "deliveredAt",
      "firstOpenedAt",
      "lastOpenedAt",
      "openCount",
      "firstClickedAt",
      "lastClickedAt",
      "clickCount",
      "bouncedAt",
      "complainedAt",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "resendWebhookEvent"),
    ["arbitraryEmailId"],
  );
  assert.deepEqual(
    selectedScalarFields(source, "emailTemplate"),
    ["purpose"],
  );
  assert.match(
    source,
    /addedRuntimeRoleProbes: \[[\s\S]*"ArbitraryEmail",[\s\S]*"ArbitraryEmail\.text",[\s\S]*"ResendWebhookEvent\.arbitraryEmailId",[\s\S]*"EmailTemplate\.purpose",[\s\S]*\]/,
  );
});
