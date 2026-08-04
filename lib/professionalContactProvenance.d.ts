export function isPublicEmailProviderDomain(domain: string): boolean;
export function isGenericProfessionalAlias(localPart: string): boolean;
export function assertNamedBusinessEmail(
  value: unknown,
  field?: string,
): string;
export function canonicalPublicHttpsUrl(
  value: unknown,
  field?: string,
): string;
export function normalizedIdentityTokens(value: unknown): string[];
export function emailPatternMatches(
  personName: string,
  email: string,
): string[];
export function domainsAssociated(left: string, right: string): boolean;
export function validateProfessionalContactProvenance(
  submission: unknown,
  provenance: unknown,
  context: {
    claimProvenanceToken: string;
    personName: string;
    organizationName: string;
    website: string | null;
  },
): unknown;
