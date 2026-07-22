export const CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS = 10 * 60 * 1_000;

export const CONTACT_AUDIT_FLAGGED_FINDINGS = [
  "changed",
  "stale",
  "ambiguous",
] as const;

export type ContactAuditResolutionEligibility =
  | "eligible"
  | "not_eligible"
  | "active_claim"
  | "contact_missing"
  | "contact_changed";

interface ContactAuditSnapshot {
  snapshotEmail: string | null;
  snapshotPhone: string | null;
  snapshotDirectOutreachNote: string | null;
  snapshotName: string | null;
  snapshotRole: string | null;
  snapshotSource: string | null;
  snapshotNotes: string | null;
  snapshotIsFullTeam: boolean | null;
}

interface ContactAuditTarget {
  state: string;
  email: string | null;
  phone: string | null;
  directOutreachNote: string | null;
  name: string | null;
  role: string | null;
  source: string | null;
  notes: string | null;
  isFullTeam: boolean;
}

interface ContactAuditResolutionTarget extends ContactAuditSnapshot {
  status: string;
  verifiedAt: Date | null;
  finding: string | null;
  resolution: string | null;
  resolutionClaimToken: string | null;
  resolutionClaimedAt: Date | null;
  contact: ContactAuditTarget | null;
}

export function contactStillMatchesAuditSnapshot(
  job: ContactAuditSnapshot,
  contact: ContactAuditTarget,
): boolean {
  return (
    contact.state === "active" &&
    contact.email === job.snapshotEmail &&
    contact.phone === job.snapshotPhone &&
    contact.directOutreachNote === job.snapshotDirectOutreachNote &&
    contact.name === job.snapshotName &&
    contact.role === job.snapshotRole &&
    contact.source === job.snapshotSource &&
    contact.notes === job.snapshotNotes &&
    (job.snapshotIsFullTeam === null ||
      contact.isFullTeam === job.snapshotIsFullTeam)
  );
}

export function contactAuditResolutionClaimIsActive(
  claim: {
    resolutionClaimToken: string | null;
    resolutionClaimedAt: Date | null;
  },
  now: Date,
): boolean {
  if (!claim.resolutionClaimToken) return false;
  if (!claim.resolutionClaimedAt) return true;
  return claim.resolutionClaimedAt > contactAuditResolutionClaimStaleBefore(now);
}

export function contactAuditResolutionClaimStaleBefore(now: Date): Date {
  return new Date(
    now.getTime() - CONTACT_AUDIT_RESOLUTION_CLAIM_TTL_MS,
  );
}

export function contactAuditResolutionEligibility(
  job: ContactAuditResolutionTarget,
  now: Date,
): ContactAuditResolutionEligibility {
  if (
    job.status !== "complete" ||
    !job.verifiedAt ||
    !job.finding ||
    !CONTACT_AUDIT_FLAGGED_FINDINGS.includes(
      job.finding as (typeof CONTACT_AUDIT_FLAGGED_FINDINGS)[number],
    ) ||
    job.resolution !== null
  ) {
    return "not_eligible";
  }
  if (contactAuditResolutionClaimIsActive(job, now)) {
    return "active_claim";
  }
  if (!job.contact) return "contact_missing";
  if (!contactStillMatchesAuditSnapshot(job, job.contact)) {
    return "contact_changed";
  }
  return "eligible";
}
