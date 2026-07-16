import "dotenv/config";
import { db } from "@/lib/db";
import {
  adoptConfiguredSheetContacts,
  SHEETS_TARGET_CHANGE_CONFIRMATION,
  validateSheetBootstrapTarget,
  type SheetTargetOverrides,
} from "@/lib/sheets";

function targetChangeConfirmed(): boolean {
  const value = process.env.SHEETS_TARGET_CHANGE_CONFIRMATION?.trim() ?? "";
  if (!value) return false;
  if (value !== SHEETS_TARGET_CHANGE_CONFIRMATION) {
    throw new Error(
      `SHEETS_TARGET_CHANGE_CONFIRMATION must be exactly ${SHEETS_TARGET_CHANGE_CONFIRMATION}`
    );
  }
  return true;
}

function targetOverrides(): SheetTargetOverrides {
  return {
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    tabName: process.env.SHEETS_TAB,
    confirmTargetChange: targetChangeConfirmed(),
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const validateOnly = args.delete("--validate-target-only");
  if (args.size > 0) {
    throw new Error(`Unknown argument(s): ${Array.from(args).join(", ")}`);
  }

  const overrides = targetOverrides();
  if (validateOnly) {
    const resolution = await validateSheetBootstrapTarget(overrides);
    console.log(
      JSON.stringify({
        event: "sheet_contact_adoption_target_validated",
        targetSource: resolution.source,
        targetChanged: resolution.targetChanged,
        targetConfigured: true,
        credentialsConfigured: true,
        targetReadable: true,
        headerValidated: true,
      })
    );
    return;
  }

  const result = await adoptConfiguredSheetContacts(overrides);
  console.log(
    JSON.stringify({
      event: "sheet_contact_adoption_complete",
      targetSource: result.targetSource,
      targetChanged: result.targetChanged,
      tabName: result.tabName,
      rowsIdentified: result.rowsIdentified,
      contactsUpserted: result.contactsUpserted,
      legacyContactsAdopted: result.legacyContactsAdopted,
      adoptionVerified: result.adoptionVerified,
    })
  );
}

main()
  .catch((error) => {
    console.error(
      "Sheet contact adoption failed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
