export const DIRECT_OUTREACH_RULE_PREFIX = "DIRECT_OUTREACH ";
export const DIRECT_OUTREACH_INSTRUCTION_EXCERPT_MAX_LENGTH =
  8_000 - DIRECT_OUTREACH_RULE_PREFIX.length;

export function canonicalDirectOutreachInstructionExcerpt(
  excerpt: string,
): string {
  return `${DIRECT_OUTREACH_RULE_PREFIX}${excerpt}`;
}

export function directOutreachInstructionExcerptFromCanonical(
  value: string,
): string {
  return value.startsWith(DIRECT_OUTREACH_RULE_PREFIX)
    ? value.slice(DIRECT_OUTREACH_RULE_PREFIX.length)
    : value;
}
