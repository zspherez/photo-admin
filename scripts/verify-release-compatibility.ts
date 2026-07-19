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
        OR: [{ countryCode: "US" }, { countryName: { not: null } }],
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
    db.contactResearchJob.count({ take: 1 }),
    db.contactResearchCandidate.count({ take: 1 }),
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
        contactResearchJobProbe,
        contactResearchCandidateProbe,
      ].every(Number.isInteger),
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
