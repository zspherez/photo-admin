import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  assertReleaseCompatibility,
  ReleaseCompatibilityError,
} from "@/lib/releaseCompatibility";
import {
  SHEETS_SPREADSHEET_ID_SETTING,
  SHEETS_TAB_SETTING,
} from "@/lib/sheets";

function parseArguments(): { requireSheetAdoption: boolean } {
  const args = new Set(process.argv.slice(2));
  const requireSheetAdoption = args.delete("--require-sheet-adoption");
  if (args.size > 0) {
    throw new ReleaseCompatibilityError(
      `Unknown argument(s): ${Array.from(args).join(", ")}`
    );
  }
  return { requireSheetAdoption };
}

async function main(): Promise<void> {
  const { requireSheetAdoption } = parseArguments();
  const [
    settings,
    activeUnownedSheetContacts,
    contactProbe,
    directOutreachNoteProbe,
    directOutreachProvenanceProbe,
    festivalGeographyProbe,
    outreachKindProbe,
    outreachDispatchIdentityConstraintProbe,
    outreachAttemptProbe,
    syncLeaseProbe,
    artistClaimProbe,
    contactResearchJobProbe,
    contactResearchCandidateProbe,
    contactResearchDirectOutreachProbe,
    artistResearchSkipProbe,
    agentRuleSetProbe,
    edmtrainVenueProbe,
    contactAuditRequestProbe,
    contactAuditRunProbe,
    contactAuditJobProbe,
    contactAuditAlternativeProbe,
    arbitraryEmailProbe,
    resendWebhookArbitraryEmailProbe,
    emailTemplateProbe,
    dashboardShowSnapshotProbe,
    dashboardShowSnapshotMemberProbe,
    trajectoryModelRunProbe,
    trajectoryRunArtistProbe,
    trajectoryRecommendationProbe,
    trajectoryImportIssueProbe,
    trajectoryConstraintProbe,
    trajectoryReadyIndexProbe,
  ] = await Promise.all([
    db.setting.findMany({
      where: {
        key: { in: [SHEETS_SPREADSHEET_ID_SETTING, SHEETS_TAB_SETTING] },
      },
      select: { key: true, value: true },
    }),
    db.contact.count({
      where: {
        source: "sheet",
        sourceKey: null,
        state: "active",
      },
    }),
    db.contact.count({ where: { state: "active" }, take: 1 }),
    db.contact.count({
      where: { directOutreachNote: { not: null } },
      take: 1,
    }),
    db.contact.findMany({
      take: 1,
      select: {
        directOutreachIdentity: true,
        directOutreachSourceJobId: true,
        directOutreachRuleVersion: true,
        directOutreachRuleText: true,
        directOutreachManagerName: true,
        directOutreachManagerCompany: true,
        directOutreachEvidenceUrls: true,
        directOutreachEvidence: true,
      },
    }),
    db.show.count({
      where: {
        OR: [
          { countryCode: "US" },
          { countryName: { not: null } },
          {
            festivalNycStatus: {
              in: ["inside_nyc", "outside_nyc", "unknown"],
            },
          },
        ],
      },
      take: 1,
    }),
    db.outreach.findMany({
      take: 1,
      select: {
        id: true,
        kind: true,
        parentOutreachId: true,
        expectedRecipientContactId: true,
        expectedRecipientArtistId: true,
        expectedRecipientEmail: true,
        expectedRecipientUpdatedAt: true,
      },
    }),
    db.$queryRaw<Array<{ constraintName: string; validated: boolean }>>(
      Prisma.sql`
        SELECT
          constraint_row."conname" AS "constraintName",
          constraint_row."convalidated" AS "validated"
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_row
          ON table_row.oid = constraint_row."conrelid"
        JOIN pg_namespace AS namespace_row
          ON namespace_row.oid = table_row."relnamespace"
        WHERE namespace_row."nspname" = current_schema()
          AND table_row."relname" = 'Outreach'
          AND constraint_row."conname" =
            'Outreach_dispatch_recipient_identity_check'
          AND constraint_row."contype" = 'c'
      `,
    ),
    db.outreachSendAttempt.count({ take: 1 }),
    db.integrationSyncLease.count({ take: 1 }),
    db.artistIdentityNameClaim.count({ take: 1 }),
    db.contactResearchJob.findMany({
      take: 1,
      select: {
        claimedAgentRules: true,
        claimedAgentRulesVersion: true,
        claimedDirectOutreachRules: true,
      },
    }),
    db.contactResearchCandidate.findMany({
      take: 1,
      select: {
        needsApproval: true,
        officialSourceType: true,
        officialSourceUrl: true,
        officialManagementLabel: true,
        officialSourceEvidence: true,
      },
    }),
    db.contactResearchDirectOutreachProposal.findMany({
      take: 1,
      select: {
        id: true,
        jobId: true,
        ruleId: true,
        ruleVersion: true,
        canonicalRule: true,
        normalizedManagerName: true,
        managerName: true,
        managerCompany: true,
        note: true,
        sourceUrls: true,
        evidenceQuotes: true,
        status: true,
        contactId: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.artistResearchSkip.findMany({
      take: 1,
      select: {
        id: true,
        artistId: true,
        source: true,
        reason: true,
        sourceJobId: true,
        agentRuleVersion: true,
        agentRuleText: true,
        setAt: true,
        clearedAt: true,
        clearedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.agentRuleSet.findMany({
      take: 1,
      select: {
        scope: true,
        instructions: true,
        directOutreachRules: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.edmtrainVenue.count({
      where: {
        nycStatus: { in: ["inside_nyc", "outside_nyc", "unknown"] },
      },
      take: 1,
    }),
    db.contactAuditRequest.findMany({
      take: 1,
      select: {
        id: true,
        status: true,
        requestedAt: true,
        startedAt: true,
        completedAt: true,
        runId: true,
        attemptCount: true,
        lastAttemptAt: true,
        lastWorkflowRunId: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.contactAuditRun.findMany({
      take: 1,
      select: {
        id: true,
        status: true,
        contactCount: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.contactAuditJob.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        contactId: true,
        artistId: true,
        snapshotArtistName: true,
        snapshotEmail: true,
        snapshotPhone: true,
        snapshotDirectOutreachNote: true,
        snapshotName: true,
        snapshotRole: true,
        snapshotSource: true,
        snapshotNotes: true,
        status: true,
        attemptCount: true,
        claimedAt: true,
        claimExpiresAt: true,
        claimToken: true,
        finding: true,
        sourceUrls: true,
        evidence: true,
        confidence: true,
        agentNotes: true,
        verifiedAt: true,
        reviewedAt: true,
        resolution: true,
        resolvedAt: true,
        selectedAlternativeId: true,
        resolvedContactId: true,
        resolvedArtistId: true,
        resolvedArtistName: true,
        resolvedEmail: true,
        resolvedPhone: true,
        resolvedDirectOutreachNote: true,
        resolvedName: true,
        resolvedRole: true,
        resolvedSource: true,
        resolvedState: true,
        resolutionClaimToken: true,
        resolutionClaimedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.contactAuditAlternative.findMany({
      take: 1,
      select: {
        id: true,
        jobId: true,
        normalizedEmail: true,
        email: true,
        name: true,
        role: true,
        sourceUrls: true,
        evidence: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.arbitraryEmail.findMany({
      take: 1,
      select: {
        id: true,
        recipientEmails: true,
        subject: true,
        html: true,
        text: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        utmTerm: true,
        status: true,
        error: true,
        providerMessageId: true,
        idempotencyKey: true,
        providerRequest: true,
        requestHash: true,
        testSend: true,
        scheduledFor: true,
        nextAttemptAt: true,
        claimedAt: true,
        claimToken: true,
        lastAttemptAt: true,
        firstAttemptAt: true,
        attemptCount: true,
        failureDisposition: true,
        providerCredentialScope: true,
        sentAt: true,
        deliveredAt: true,
        firstOpenedAt: true,
        lastOpenedAt: true,
        openCount: true,
        firstClickedAt: true,
        lastClickedAt: true,
        clickCount: true,
        bouncedAt: true,
        complainedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.resendWebhookEvent.findMany({
      take: 1,
      select: {
        arbitraryEmailId: true,
      },
    }),
    db.emailTemplate.findMany({
      take: 1,
      select: {
        purpose: true,
      },
    }),
    db.dashboardShowSnapshot.findMany({
      take: 1,
      select: {
        id: true,
        ownerKey: true,
        queryKey: true,
        total: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    db.dashboardShowSnapshotMember.findMany({
      take: 1,
      select: {
        snapshotId: true,
        position: true,
        showId: true,
        sortDate: true,
      },
    }),
    db.trajectoryModelRun.findMany({
      take: 1,
      select: {
        id: true,
        producer: true,
        producerRunId: true,
        contractVersion: true,
        producerSchemaVersion: true,
        artifactSha256: true,
        fullArtifactSha256: true,
        artifactGzip: true,
        artifactByteLength: true,
        producerRevision: true,
        generatedAt: true,
        asOfDate: true,
        decisionDate: true,
        minimumShowDate: true,
        validUntil: true,
        modelStatus: true,
        validationReference: true,
        status: true,
        summary: true,
        failureCode: true,
        failureMessage: true,
        importedAt: true,
        activatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.trajectoryRunArtist.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        artistId: true,
        edmtrainArtistId: true,
        sourceName: true,
        spotifyArtistId: true,
        raArtistId: true,
        coverageState: true,
        momentumBand: true,
        isEarlyStage: true,
        isEstablished: true,
        isVeteran: true,
        eventDelta6m: true,
        eventsPrior6m: true,
        eventsRecent6m: true,
        marketsPrior6m: true,
        marketsRecent6m: true,
        careerAgeYears: true,
        analogSummary: true,
        releaseContext: true,
        genres: true,
        createdAt: true,
      },
    }),
    db.trajectoryRecommendation.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        showId: true,
        runArtistId: true,
        arm: true,
        listRank: true,
        isSuggested: true,
        slatePosition: true,
        billingPosition: true,
        lineupSize: true,
        isFirstBilled: true,
        rationale: true,
        sourceFingerprint: true,
        createdAt: true,
      },
    }),
    db.trajectoryImportIssue.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        recommendationKey: true,
        code: true,
        detail: true,
        createdAt: true,
      },
    }),
    db.$queryRaw<Array<{ constraintName: string; validated: boolean }>>(
      Prisma.sql`
        SELECT
          constraint_row."conname" AS "constraintName",
          constraint_row."convalidated" AS "validated"
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS table_row
          ON table_row.oid = constraint_row."conrelid"
        JOIN pg_namespace AS namespace_row
          ON namespace_row.oid = table_row."relnamespace"
        WHERE namespace_row."nspname" = current_schema()
          AND table_row."relname" IN (
            'TrajectoryModelRun',
            'TrajectoryRunArtist',
            'TrajectoryRecommendation'
          )
          AND constraint_row."contype" = 'c'
      `,
    ),
    db.$queryRaw<Array<{ indexDefinition: string }>>(
      Prisma.sql`
        SELECT indexdef AS "indexDefinition"
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'TrajectoryModelRun_one_ready_artist_trajectory_idx'
      `,
    ),
  ]);
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));

  assertReleaseCompatibility(
    {
      databaseProbeSucceeded: [
        contactProbe,
        directOutreachNoteProbe,
        festivalGeographyProbe,
        outreachAttemptProbe,
        syncLeaseProbe,
        artistClaimProbe,
        edmtrainVenueProbe,
      ].every(Number.isInteger) &&
        [
          contactResearchJobProbe,
          contactResearchCandidateProbe,
          contactResearchDirectOutreachProbe,
          directOutreachProvenanceProbe,
          outreachKindProbe,
          outreachDispatchIdentityConstraintProbe,
          artistResearchSkipProbe,
          agentRuleSetProbe,
          contactAuditRequestProbe,
          contactAuditRunProbe,
          contactAuditJobProbe,
          contactAuditAlternativeProbe,
          arbitraryEmailProbe,
          resendWebhookArbitraryEmailProbe,
          emailTemplateProbe,
          dashboardShowSnapshotProbe,
          dashboardShowSnapshotMemberProbe,
          trajectoryModelRunProbe,
          trajectoryRunArtistProbe,
          trajectoryRecommendationProbe,
          trajectoryImportIssueProbe,
          trajectoryConstraintProbe,
          trajectoryReadyIndexProbe,
        ].every(Array.isArray) &&
        outreachDispatchIdentityConstraintProbe.some(
          (constraint) =>
            constraint.constraintName ===
              "Outreach_dispatch_recipient_identity_check" &&
            constraint.validated,
        ) &&
        trajectoryConstraintProbe.length >= 10 &&
        trajectoryConstraintProbe.every((constraint) => constraint.validated) &&
        trajectoryReadyIndexProbe.some(
          (index) =>
            index.indexDefinition.includes("UNIQUE") &&
            index.indexDefinition.includes("status") &&
            index.indexDefinition.includes("ready"),
        ),
      configuredSpreadsheetId:
        values.get(SHEETS_SPREADSHEET_ID_SETTING) ?? null,
      configuredSheetTab: values.get(SHEETS_TAB_SETTING) ?? null,
      activeUnownedSheetContacts,
    },
    requireSheetAdoption
  );
  console.log(
    JSON.stringify({
      event: "release_compatibility_verified",
      sheetAdoptionRequired: requireSheetAdoption,
      addedRuntimeRoleProbes: [
        "ArtistResearchSkip",
        "ContactResearchDirectOutreachProposal",
        "Contact.agentDirectOutreachProvenance",
        "ContactAuditRequest",
        "ContactAuditRun",
        "ContactAuditJob",
        "ContactAuditAlternative",
        "ArbitraryEmail",
        "ArbitraryEmail.text",
        "ArbitraryEmail.scheduledFor",
        "ArbitraryEmail.claimToken",
        "ArbitraryEmail.providerCredentialScope",
        "Outreach.expectedRecipientUpdatedAt",
        "Outreach_dispatch_recipient_identity_check",
        "ResendWebhookEvent.arbitraryEmailId",
        "EmailTemplate.purpose",
        "DashboardShowSnapshot",
        "DashboardShowSnapshotMember",
        "TrajectoryModelRun",
        "TrajectoryRunArtist",
        "TrajectoryRecommendation",
        "TrajectoryImportIssue",
        "TrajectoryModelRun_one_ready_artist_trajectory_idx",
      ],
    })
  );
}

main()
  .catch((error) => {
    console.error(
      "Release compatibility verification failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
