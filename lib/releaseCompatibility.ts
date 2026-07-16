export interface ReleaseCompatibilitySnapshot {
  databaseProbeSucceeded: boolean;
  configuredSpreadsheetId: string | null;
  configuredSheetTab: string | null;
  activeUnownedSheetContacts: number;
}

export class ReleaseCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCompatibilityError";
  }
}

export function assertReleaseCompatibility(
  snapshot: ReleaseCompatibilitySnapshot,
  requireSheetAdoption: boolean
): void {
  if (!snapshot.databaseProbeSucceeded) {
    throw new ReleaseCompatibilityError(
      "Exact release code could not query every required schema surface"
    );
  }
  if (!Number.isInteger(snapshot.activeUnownedSheetContacts)) {
    throw new ReleaseCompatibilityError(
      "Sheet contact quarantine state is malformed"
    );
  }
  if (!requireSheetAdoption) return;

  if (
    !snapshot.configuredSpreadsheetId?.trim() ||
    !snapshot.configuredSheetTab?.trim()
  ) {
    throw new ReleaseCompatibilityError(
      "Configured Sheet target is incomplete after adoption"
    );
  }
  if (snapshot.activeUnownedSheetContacts !== 0) {
    throw new ReleaseCompatibilityError(
      "Active legacy Sheet contacts remain outside verified ownership"
    );
  }
}
