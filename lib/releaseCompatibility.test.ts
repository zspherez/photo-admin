import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertReleaseCompatibility } from "./releaseCompatibility";

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

test("schema compatibility succeeds when every database probe succeeds", () => {
  assert.doesNotThrow(() =>
    assertReleaseCompatibility(
      {
        databaseProbeSucceeded: true,
      }
    )
  );
});

test("required schema probes fail closed", () => {
  assert.throws(
    () =>
      assertReleaseCompatibility(
        {
          databaseProbeSucceeded: false,
        }
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
    /contactProbe,\s*contactExportSnapshotProbe,\s*directOutreachNoteProbe,\s*directOutreachProvenanceProbe,\s*festivalGeographyProbe,\s*outreachKindProbe,\s*outreachDispatchIdentityConstraintProbe,\s*outreachAttemptProbe/,
  );
  assert.match(source, /db\.contactExportSnapshot\.findMany/);
  assert.deepEqual(
    selectedScalarFields(source, "outreach"),
    [
      "id",
      "kind",
      "parentOutreachId",
      "expectedRecipientContactId",
      "expectedRecipientArtistId",
      "expectedRecipientEmail",
      "expectedRecipientUpdatedAt",
      "trajectoryRecommendationId",
    ],
  );
  assert.match(
    source,
    /FROM pg_constraint AS constraint_row[\s\S]*table_row\."relname" = 'Outreach'[\s\S]*Outreach_dispatch_recipient_identity_check[\s\S]*constraint_row\."contype" = 'c'/,
  );
  assert.match(
    source,
    /outreachDispatchIdentityConstraintProbe\.some\([\s\S]*constraint\.validated/,
  );
  assert.match(source, /directOutreachNote: \{ not: null \}/);
  assert.deepEqual(
    selectedScalarFields(source, "contact"),
    [
      "directOutreachIdentity",
      "directOutreachSourceJobId",
      "directOutreachRuleVersion",
      "directOutreachRuleText",
      "directOutreachManagerName",
      "directOutreachManagerCompany",
      "directOutreachEvidenceUrls",
      "directOutreachEvidence",
    ],
  );
  assert.match(
    source,
    /db\.contactResearchJob\.findMany\(\{[\s\S]*claimedAgentRules: true,[\s\S]*claimedAgentRulesVersion: true,[\s\S]*claimedDirectOutreachRules: true/,
  );
  assert.doesNotMatch(source, /db\.contactResearchJob\.count/);
  assert.match(
    source,
    /db\.contactResearchCandidate\.findMany\(\{[\s\S]*needsApproval: true,[\s\S]*officialSourceType: true,[\s\S]*officialSourceUrl: true,[\s\S]*officialManagementLabel: true,[\s\S]*officialSourceEvidence: true/,
  );
  assert.doesNotMatch(source, /db\.contactResearchCandidate\.count/);
  assert.match(
    source,
    /pg_get_constraintdef[\s\S]*table_row\."relname" = 'ContactResearchCandidate'[\s\S]*ContactResearchCandidate_status_check/,
  );
  assert.match(
    source,
    /contactResearchCandidateStatusConstraintProbe\.some\([\s\S]*constraintDefinition\.includes\("pending"\)[\s\S]*constraintDefinition\.includes\("approved"\)[\s\S]*constraintDefinition\.includes\("rejected"\)[\s\S]*constraintDefinition\.includes\("superseded"\)/,
  );
  assert.match(
    source,
    /db\.contactResearchDirectOutreachProposal\.findMany\(\{[\s\S]*ruleId: true,[\s\S]*canonicalRule: true,[\s\S]*evidenceQuotes: true,[\s\S]*reviewedAt: true/,
  );
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
    /db\.agentRuleSet\.findMany\(\{[\s\S]*scope: true,[\s\S]*instructions: true,[\s\S]*directOutreachRules: true,[\s\S]*version: true,[\s\S]*createdAt: true,[\s\S]*updatedAt: true/,
  );
  assert.match(
    source,
    /\[\s*contactResearchJobProbe,\s*contactResearchCandidateProbe,\s*contactResearchCandidateStatusConstraintProbe,\s*contactExportSnapshotProbe,\s*contactResearchDirectOutreachProbe,\s*directOutreachProvenanceProbe,\s*outreachKindProbe,\s*outreachDispatchIdentityConstraintProbe,\s*artistResearchSkipProbe,\s*agentRuleSetProbe,\s*contactAuditRequestProbe,\s*contactAuditRunProbe,\s*contactAuditRosterSnapshotProbe,\s*contactAuditRosterEntryProbe,\s*contactAuditJobProbe,\s*contactAuditAlternativeProbe,\s*contactAuditArtistDecisionProbe,\s*contactAuditDecisionContactProbe,\s*contactAuditRosterConstraintProbe,\s*contactAuditRosterIndexProbe,\s*arbitraryEmailProbe,\s*resendWebhookArbitraryEmailProbe,\s*emailTemplateProbe,\s*dashboardShowSnapshotProbe,\s*dashboardShowSnapshotMemberProbe,\s*trajectoryModelRunProbe,\s*trajectoryRunArtistProbe,\s*trajectoryRecommendationProbe,\s*trajectoryImportIssueProbe,\s*trajectoryFeedbackEventProbe,\s*trajectoryShowOutcomeProbe,\s*trajectoryConstraintProbe,\s*trajectoryReadyIndexProbe,\s*trajectoryFeedbackTriggerProbe,\s*trajectoryFeedbackIndexProbe,\s*\]\.every\(Array\.isArray\)/,
  );
  assert.match(
    source,
    /contactAuditRosterConstraintProbe\.length === 6[\s\S]*contactAuditRosterConstraintProbe\.every\([\s\S]*constraint\.validated/,
  );
  assert.match(
    source,
    /contactAuditRosterIndexProbe\.length === 4[\s\S]*ContactAuditRosterEntry_rosterSnapshotId_email_idx[\s\S]*indexDefinition\.includes\("lower"\)/,
  );
  assert.match(
    source,
    /db\.edmtrainVenue\.count\(\{[\s\S]*nycStatus: \{ in: \["inside_nyc", "outside_nyc", "unknown"\] \}/
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditRequest"),
    [
      "id",
      "requestKey",
      "source",
      "status",
      "requestedAt",
      "startedAt",
      "completedAt",
      "runId",
      "attemptCount",
      "lastAttemptAt",
      "lastWorkflowRunId",
      "lastError",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditRun"),
    ["id", "status", "contactCount", "completedAt", "createdAt", "updatedAt"],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditRosterSnapshot"),
    [
      "id",
      "runId",
      "snapshotArtistId",
      "snapshotArtistName",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditRosterEntry"),
    [
      "id",
      "rosterSnapshotId",
      "snapshotContactId",
      "snapshotEmail",
      "snapshotPhone",
      "snapshotDirectOutreachNote",
      "snapshotName",
      "snapshotRole",
      "snapshotSource",
      "snapshotNotes",
      "snapshotIsFullTeam",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditJob"),
    [
      "id",
      "runId",
      "contactId",
      "artistId",
      "rosterSnapshotId",
      "targetRosterEntryId",
      "snapshotArtistName",
      "snapshotEmail",
      "snapshotPhone",
      "snapshotDirectOutreachNote",
      "snapshotName",
      "snapshotRole",
      "snapshotSource",
      "snapshotNotes",
      "snapshotIsFullTeam",
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
      "rosterReview",
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
    selectedScalarFields(source, "contactAuditArtistDecision"),
    [
      "id",
      "runId",
      "artistId",
      "snapshotArtistName",
      "action",
      "selectedAlternativeId",
      "createdContactId",
      "resolvedAt",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "contactAuditDecisionContact"),
    [
      "decisionId",
      "contactId",
      "action",
      "snapshotEmail",
      "snapshotPhone",
      "snapshotDirectOutreachNote",
      "snapshotName",
      "snapshotRole",
      "snapshotSource",
      "snapshotNotes",
      "snapshotIsFullTeam",
      "createdAt",
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
      "scheduledFor",
      "nextAttemptAt",
      "claimedAt",
      "claimToken",
      "lastAttemptAt",
      "firstAttemptAt",
      "attemptCount",
      "failureDisposition",
      "providerCredentialScope",
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
  assert.deepEqual(
    selectedScalarFields(source, "dashboardShowSnapshot"),
    [
      "id",
      "ownerKey",
      "queryKey",
      "total",
      "expiresAt",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "dashboardShowSnapshotMember"),
    ["snapshotId", "position", "showId", "sortDate"],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryModelRun"),
    [
      "id",
      "producer",
      "producerRunId",
      "contractVersion",
      "producerSchemaVersion",
      "artifactSha256",
      "fullArtifactSha256",
      "artifactGzip",
      "artifactByteLength",
      "producerRevision",
      "generatedAt",
      "asOfDate",
      "decisionDate",
      "minimumShowDate",
      "validUntil",
      "modelStatus",
      "validationReference",
      "status",
      "summary",
      "failureCode",
      "failureMessage",
      "importedAt",
      "activatedAt",
      "createdAt",
      "updatedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryRunArtist"),
    [
      "id",
      "runId",
      "artistId",
      "edmtrainArtistId",
      "sourceName",
      "spotifyArtistId",
      "raArtistId",
      "coverageState",
      "momentumBand",
      "isEarlyStage",
      "isEstablished",
      "isVeteran",
      "eventDelta6m",
      "eventsPrior6m",
      "eventsRecent6m",
      "marketsPrior6m",
      "marketsRecent6m",
      "careerAgeYears",
      "analogSummary",
      "releaseContext",
      "genres",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryRecommendation"),
    [
      "id",
      "runId",
      "showId",
      "runArtistId",
      "arm",
      "listRank",
      "isSuggested",
      "slatePosition",
      "billingPosition",
      "lineupSize",
      "isFirstBilled",
      "rationale",
      "sourceFingerprint",
      "createdAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryImportIssue"),
    ["id", "runId", "recommendationKey", "code", "detail", "createdAt"],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryFeedbackEvent"),
    [
      "id",
      "recommendationId",
      "action",
      "propensity",
      "manualOverride",
      "notes",
      "idempotencyKey",
      "supersedesId",
      "recordedAt",
    ],
  );
  assert.deepEqual(
    selectedScalarFields(source, "trajectoryShowOutcome"),
    [
      "id",
      "recommendationId",
      "attended",
      "access",
      "keeperCount",
      "relationshipValue",
      "publicationValue",
      "shootability",
      "venueAccessibility",
      "notes",
      "idempotencyKey",
      "supersedesId",
      "recordedAt",
    ],
  );
  assert.match(
    source,
    /TrajectoryModelRun_one_ready_artist_trajectory_idx/,
  );
  assert.match(
    source,
    /trajectoryConstraintProbe\.every\(\(constraint\) => constraint\.validated\)/,
  );
  assert.match(
    source,
    /addedRuntimeRoleProbes: \[[\s\S]*"ArbitraryEmail",[\s\S]*"ArbitraryEmail\.text",[\s\S]*"ArbitraryEmail\.scheduledFor",[\s\S]*"ArbitraryEmail\.claimToken",[\s\S]*"ArbitraryEmail\.providerCredentialScope",[\s\S]*"Outreach\.expectedRecipientUpdatedAt",[\s\S]*"Outreach_dispatch_recipient_identity_check",[\s\S]*"ResendWebhookEvent\.arbitraryEmailId",[\s\S]*"EmailTemplate\.purpose",[\s\S]*"DashboardShowSnapshot",[\s\S]*"DashboardShowSnapshotMember",[\s\S]*"TrajectoryModelRun",[\s\S]*"TrajectoryRunArtist",[\s\S]*"TrajectoryRecommendation",[\s\S]*"TrajectoryImportIssue",[\s\S]*"TrajectoryFeedbackEvent",[\s\S]*"TrajectoryShowOutcome",[\s\S]*"Outreach\.trajectoryRecommendationId",[\s\S]*"Trajectory feedback append-only triggers",[\s\S]*"Trajectory feedback indexes",[\s\S]*"TrajectoryModelRun_one_ready_artist_trajectory_idx",[\s\S]*\]/,
  );
  assert.match(
    source,
    /trajectoryFeedbackTriggerProbe\.length === 5[\s\S]*trigger\.enabled === "O"/,
  );
  assert.match(source, /trajectoryFeedbackIndexProbe\.length === 9/);
});
