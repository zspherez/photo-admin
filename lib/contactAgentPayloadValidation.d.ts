export function isObviousSyntheticPlaceholder(value: unknown): boolean;
export function assertNonSyntheticText(
  value: unknown,
  field: string
): void;
export function assertPublicHttpsSourceUrl(
  value: unknown,
  field: string
): void;
export function assertSubstantiveCandidateEvidence(
  value: unknown,
  field: string,
  identifiers: {
    email?: unknown;
    name?: unknown;
    company?: unknown;
  },
  minimumLength?: number
): void;
export function validateResearchBrokerPayload(
  action: string,
  value: unknown
): void;
export function validateResearchSubmissionPayload(value: unknown): void;
export function validateAuditSubmissionPayload(value: unknown): void;
