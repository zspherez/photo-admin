import "dotenv/config";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { assertReleaseCompatibility } from "@/lib/releaseCompatibility";

async function main(): Promise<void> {
  const [
    contactProbe,
    contactExportSnapshotProbe,
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
    contactResearchCandidateStatusConstraintProbe,
    contactResearchDirectOutreachProbe,
    artistResearchSkipProbe,
    agentRuleSetProbe,
    edmtrainVenueProbe,
    contactAuditRequestProbe,
    contactAuditRunProbe,
    contactAuditRosterSnapshotProbe,
    contactAuditRosterEntryProbe,
    contactAuditJobProbe,
    contactAuditAlternativeProbe,
    contactAuditArtistDecisionProbe,
    contactAuditDecisionContactProbe,
    contactAuditRosterConstraintProbe,
    contactAuditRosterIndexProbe,
    arbitraryEmailProbe,
    resendWebhookArbitraryEmailProbe,
    emailTemplateProbe,
    dashboardShowSnapshotProbe,
    dashboardShowSnapshotMemberProbe,
    trajectoryModelRunProbe,
    trajectoryRunArtistProbe,
    trajectoryRecommendationProbe,
    trajectoryImportIssueProbe,
    trajectoryFeedbackEventProbe,
    trajectoryShowOutcomeProbe,
    trajectoryConstraintProbe,
    trajectoryReadyIndexProbe,
    trajectoryFeedbackTriggerProbe,
    trajectoryFeedbackIndexProbe,
  ] = await Promise.all([
    db.contact.count({ where: { state: "active" }, take: 1 }),
    db.contactExportSnapshot.findMany({
      take: 1,
      select: {
        id: true,
        provider: true,
        status: true,
        idempotencyKey: true,
        contactCount: true,
        contentSha256: true,
        spreadsheetId: true,
        sheetTabId: true,
        sheetTabName: true,
        sheetUrl: true,
        requestedByRole: true,
        canonicalRows: true,
        error: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
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
        trajectoryRecommendationId: true,
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
    db.$queryRaw<
      Array<{
        constraintName: string;
        constraintDefinition: string;
        validated: boolean;
      }>
    >(Prisma.sql`
      SELECT
        constraint_row."conname" AS "constraintName",
        pg_get_constraintdef(constraint_row.oid) AS "constraintDefinition",
        constraint_row."convalidated" AS "validated"
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row
        ON table_row.oid = constraint_row."conrelid"
      JOIN pg_namespace AS namespace_row
        ON namespace_row.oid = table_row."relnamespace"
      WHERE namespace_row."nspname" = current_schema()
        AND table_row."relname" = 'ContactResearchCandidate'
        AND constraint_row."conname" =
          'ContactResearchCandidate_status_check'
        AND constraint_row."contype" = 'c'
    `),
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
        requestKey: true,
        source: true,
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
    db.contactAuditRosterSnapshot.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        snapshotArtistId: true,
        snapshotArtistName: true,
        createdAt: true,
      },
    }),
    db.contactAuditRosterEntry.findMany({
      take: 1,
      select: {
        id: true,
        rosterSnapshotId: true,
        snapshotContactId: true,
        snapshotEmail: true,
        snapshotPhone: true,
        snapshotDirectOutreachNote: true,
        snapshotName: true,
        snapshotRole: true,
        snapshotSource: true,
        snapshotNotes: true,
        snapshotIsFullTeam: true,
        createdAt: true,
      },
    }),
    db.contactAuditJob.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        contactId: true,
        artistId: true,
        rosterSnapshotId: true,
        targetRosterEntryId: true,
        snapshotArtistName: true,
        snapshotEmail: true,
        snapshotPhone: true,
        snapshotDirectOutreachNote: true,
        snapshotName: true,
        snapshotRole: true,
        snapshotSource: true,
        snapshotNotes: true,
        snapshotIsFullTeam: true,
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
        rosterReview: true,
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
    db.contactAuditArtistDecision.findMany({
      take: 1,
      select: {
        id: true,
        runId: true,
        artistId: true,
        snapshotArtistName: true,
        action: true,
        selectedAlternativeId: true,
        createdContactId: true,
        resolvedAt: true,
        createdAt: true,
      },
    }),
    db.contactAuditDecisionContact.findMany({
      take: 1,
      select: {
        decisionId: true,
        contactId: true,
        action: true,
        snapshotEmail: true,
        snapshotPhone: true,
        snapshotDirectOutreachNote: true,
        snapshotName: true,
        snapshotRole: true,
        snapshotSource: true,
        snapshotNotes: true,
        snapshotIsFullTeam: true,
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
            'ContactAuditRosterSnapshot',
            'ContactAuditRosterEntry',
            'ContactAuditJob'
          )
          AND constraint_row."conname" IN (
            'ContactAuditRosterSnapshot_runId_fkey',
            'ContactAuditRosterEntry_rosterSnapshotId_fkey',
            'ContactAuditJob_roster_link_check',
            'ContactAuditJob_rosterReview_check',
            'ContactAuditJob_rosterSnapshotId_fkey',
            'ContactAuditJob_targetRosterEntryId_fkey'
          )
      `,
    ),
    db.$queryRaw<Array<{ indexName: string; indexDefinition: string }>>(
      Prisma.sql`
        SELECT
          indexname AS "indexName",
          indexdef AS "indexDefinition"
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN (
            'ContactAuditRosterSnapshot_runId_snapshotArtistId_key',
            'ContactAuditRosterEntry_rosterSnapshotId_snapshotContactId_key',
            'ContactAuditRosterEntry_rosterSnapshotId_email_idx',
            'ContactAuditJob_targetRosterEntryId_key'
          )
      `,
    ),
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
    db.trajectoryFeedbackEvent.findMany({
      take: 1,
      select: {
        id: true,
        recommendationId: true,
        action: true,
        propensity: true,
        manualOverride: true,
        notes: true,
        idempotencyKey: true,
        supersedesId: true,
        recordedAt: true,
      },
    }),
    db.trajectoryShowOutcome.findMany({
      take: 1,
      select: {
        id: true,
        recommendationId: true,
        attended: true,
        access: true,
        keeperCount: true,
        relationshipValue: true,
        publicationValue: true,
        shootability: true,
        venueAccessibility: true,
        notes: true,
        idempotencyKey: true,
        supersedesId: true,
        recordedAt: true,
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
            'TrajectoryRecommendation',
            'TrajectoryFeedbackEvent',
            'TrajectoryShowOutcome'
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
    db.$queryRaw<
      Array<{ triggerName: string; enabled: string }>
    >(Prisma.sql`
      SELECT
        trigger_row."tgname" AS "triggerName",
        trigger_row."tgenabled" AS "enabled"
      FROM pg_trigger AS trigger_row
      JOIN pg_class AS table_row
        ON table_row.oid = trigger_row."tgrelid"
      JOIN pg_namespace AS namespace_row
        ON namespace_row.oid = table_row."relnamespace"
      WHERE namespace_row."nspname" = current_schema()
        AND NOT trigger_row."tgisinternal"
        AND trigger_row."tgname" IN (
          'TrajectoryFeedbackEvent_validate_supersession',
          'TrajectoryFeedbackEvent_append_only',
          'TrajectoryShowOutcome_validate_supersession',
          'TrajectoryShowOutcome_append_only',
          'Outreach_validate_trajectory_attribution'
        )
    `),
    db.$queryRaw<Array<{ indexName: string }>>(Prisma.sql`
      SELECT indexname AS "indexName"
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'TrajectoryFeedbackEvent_idempotencyKey_key',
          'TrajectoryFeedbackEvent_supersedesId_key',
          'TrajectoryFeedbackEvent_recommendationId_recordedAt_idx',
          'TrajectoryFeedbackEvent_action_recordedAt_idx',
          'TrajectoryShowOutcome_idempotencyKey_key',
          'TrajectoryShowOutcome_supersedesId_key',
          'TrajectoryShowOutcome_recommendationId_recordedAt_idx',
          'TrajectoryShowOutcome_recordedAt_idx',
          'Outreach_trajectoryRecommendationId_idx'
        )
    `),
  ]);
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
          contactResearchCandidateStatusConstraintProbe,
          contactExportSnapshotProbe,
          contactResearchDirectOutreachProbe,
          directOutreachProvenanceProbe,
          outreachKindProbe,
          outreachDispatchIdentityConstraintProbe,
          artistResearchSkipProbe,
          agentRuleSetProbe,
          contactAuditRequestProbe,
          contactAuditRunProbe,
          contactAuditRosterSnapshotProbe,
          contactAuditRosterEntryProbe,
          contactAuditJobProbe,
          contactAuditAlternativeProbe,
          contactAuditArtistDecisionProbe,
          contactAuditDecisionContactProbe,
          contactAuditRosterConstraintProbe,
          contactAuditRosterIndexProbe,
          arbitraryEmailProbe,
          resendWebhookArbitraryEmailProbe,
          emailTemplateProbe,
          dashboardShowSnapshotProbe,
          dashboardShowSnapshotMemberProbe,
          trajectoryModelRunProbe,
          trajectoryRunArtistProbe,
          trajectoryRecommendationProbe,
          trajectoryImportIssueProbe,
          trajectoryFeedbackEventProbe,
          trajectoryShowOutcomeProbe,
          trajectoryConstraintProbe,
          trajectoryReadyIndexProbe,
          trajectoryFeedbackTriggerProbe,
          trajectoryFeedbackIndexProbe,
        ].every(Array.isArray) &&
        contactResearchCandidateStatusConstraintProbe.some(
          (constraint) =>
            constraint.constraintName ===
              "ContactResearchCandidate_status_check" &&
            constraint.validated &&
            constraint.constraintDefinition.includes("pending") &&
            constraint.constraintDefinition.includes("approved") &&
            constraint.constraintDefinition.includes("rejected") &&
            constraint.constraintDefinition.includes("superseded"),
        ) &&
        contactAuditRosterConstraintProbe.length === 6 &&
        contactAuditRosterConstraintProbe.every(
          (constraint) => constraint.validated,
        ) &&
        contactAuditRosterIndexProbe.length === 4 &&
        contactAuditRosterIndexProbe.some(
          (index) =>
            index.indexName ===
              "ContactAuditRosterEntry_rosterSnapshotId_email_idx" &&
            index.indexDefinition.includes("lower"),
        ) &&
        outreachDispatchIdentityConstraintProbe.some(
          (constraint) =>
            constraint.constraintName ===
              "Outreach_dispatch_recipient_identity_check" &&
            constraint.validated,
        ) &&
        trajectoryConstraintProbe.length >= 31 &&
        trajectoryConstraintProbe.every((constraint) => constraint.validated) &&
        trajectoryReadyIndexProbe.some(
          (index) =>
            index.indexDefinition.includes("UNIQUE") &&
            index.indexDefinition.includes("status") &&
            index.indexDefinition.includes("ready"),
        ) &&
        trajectoryFeedbackTriggerProbe.length === 5 &&
        trajectoryFeedbackTriggerProbe.every(
          (trigger) => trigger.enabled === "O",
        ) &&
        trajectoryFeedbackIndexProbe.length === 9,
    }
  );
  console.log(
    JSON.stringify({
      event: "release_compatibility_verified",
      addedRuntimeRoleProbes: [
        "ArtistResearchSkip",
        "ContactResearchCandidate_status_check",
        "ContactResearchDirectOutreachProposal",
        "Contact.agentDirectOutreachProvenance",
        "ContactAuditRequest",
        "ContactExportSnapshot",
        "ContactAuditRun",
        "ContactAuditRosterSnapshot",
        "ContactAuditRosterEntry",
        "ContactAuditJob",
        "ContactAuditAlternative",
        "ContactAuditArtistDecision",
        "ContactAuditDecisionContact",
        "ContactAuditRoster constraints",
        "ContactAuditRoster indexes",
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
        "TrajectoryFeedbackEvent",
        "TrajectoryShowOutcome",
        "Outreach.trajectoryRecommendationId",
        "Trajectory feedback append-only triggers",
        "Trajectory feedback indexes",
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
