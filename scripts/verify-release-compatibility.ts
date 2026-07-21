import "dotenv/config";
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
    festivalGeographyProbe,
    outreachKindProbe,
    outreachAttemptProbe,
    syncLeaseProbe,
    artistClaimProbe,
    contactResearchJobProbe,
    contactResearchCandidateProbe,
    artistResearchSkipProbe,
    agentRuleSetProbe,
    edmtrainVenueProbe,
    contactAuditRunProbe,
    contactAuditJobProbe,
    contactAuditAlternativeProbe,
    arbitraryEmailProbe,
    resendWebhookArbitraryEmailProbe,
    emailTemplateProbe,
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
    db.outreach.count({
      where: { kind: "original", parentOutreachId: null },
      take: 1,
    }),
    db.outreachSendAttempt.count({ take: 1 }),
    db.integrationSyncLease.count({ take: 1 }),
    db.artistIdentityNameClaim.count({ take: 1 }),
    db.contactResearchJob.findMany({
      take: 1,
      select: {
        claimedAgentRules: true,
        claimedAgentRulesVersion: true,
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
  ]);
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));

  assertReleaseCompatibility(
    {
      databaseProbeSucceeded: [
        contactProbe,
        directOutreachNoteProbe,
        festivalGeographyProbe,
        outreachKindProbe,
        outreachAttemptProbe,
        syncLeaseProbe,
        artistClaimProbe,
        edmtrainVenueProbe,
      ].every(Number.isInteger) &&
        [
          contactResearchJobProbe,
          contactResearchCandidateProbe,
          artistResearchSkipProbe,
          agentRuleSetProbe,
          contactAuditRunProbe,
          contactAuditJobProbe,
          contactAuditAlternativeProbe,
          arbitraryEmailProbe,
          resendWebhookArbitraryEmailProbe,
          emailTemplateProbe,
        ].every(Array.isArray),
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
        "ContactAuditRun",
        "ContactAuditJob",
        "ContactAuditAlternative",
        "ArbitraryEmail",
        "ArbitraryEmail.text",
        "ResendWebhookEvent.arbitraryEmailId",
        "EmailTemplate.purpose",
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
