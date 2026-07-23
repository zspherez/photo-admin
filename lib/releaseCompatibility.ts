export interface ReleaseCompatibilitySnapshot {
  databaseProbeSucceeded: boolean;
}

export class ReleaseCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCompatibilityError";
  }
}

export function assertReleaseCompatibility(
  snapshot: ReleaseCompatibilitySnapshot
): void {
  if (!snapshot.databaseProbeSucceeded) {
    throw new ReleaseCompatibilityError(
      "Exact release code could not query every required schema surface"
    );
  }
}
