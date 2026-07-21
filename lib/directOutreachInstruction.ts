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
  const excerpt = value.startsWith(DIRECT_OUTREACH_RULE_PREFIX)
    ? value.slice(DIRECT_OUTREACH_RULE_PREFIX.length)
    : value;
  if (!excerpt.trim().startsWith("{")) return excerpt;
  try {
    const parsed: unknown = JSON.parse(excerpt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return excerpt;
    }
    const input = parsed as Record<string, unknown>;
    const manager =
      typeof input.manager === "string"
        ? input.manager.trim()
        : typeof input.managerName === "string"
          ? input.managerName.trim()
          : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!manager || !note) return excerpt;
    const punctuatedNote = /[.!?]$/.test(note) ? note : `${note}.`;
    return `When an artist is managed by ${manager}, add this direct outreach note: ${punctuatedNote}`;
  } catch {
    return excerpt;
  }
}
