import type { RecipientDeliveryMode } from "@/lib/recipientDelivery";

export interface FestivalPlanCandidate {
  selectionId: string;
  contactId: string;
  coveredArtistIds: string[];
  groupKey: string;
  outreachKind: "original" | "follow_up";
  recipients: string[];
  primaryRecipientEmail: string | null;
  recipientDeliveryMode: RecipientDeliveryMode;
  immutableDeliveryMode: boolean;
}

export function festivalConfirmedPlan(
  candidates: readonly FestivalPlanCandidate[],
  selectedIds: readonly string[],
  deliveryMode: RecipientDeliveryMode,
) {
  const selected = new Set(selectedIds);
  const groups = new Map<string, {
    groupKey: string;
    kind: "original" | "follow_up";
    selectionIds: string[];
    contactIds: string[];
    coveredArtistIds: string[];
    recipients: string[];
    primaryRecipientEmail: string | null;
    recipientDeliveryMode: RecipientDeliveryMode;
    immutableDeliveryMode: boolean;
    parentOutreachId: string | null;
    retryOutreachId: string | null;
  }>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.selectionId)) continue;
    const existing = groups.get(candidate.groupKey);
    if (existing) {
      existing.selectionIds.push(candidate.selectionId);
      existing.contactIds.push(candidate.contactId);
      existing.coveredArtistIds.push(...candidate.coveredArtistIds);
    } else {
      groups.set(candidate.groupKey, {
        groupKey: candidate.groupKey,
        kind: candidate.outreachKind,
        selectionIds: [candidate.selectionId],
        contactIds: [candidate.contactId],
        coveredArtistIds: [...candidate.coveredArtistIds],
        recipients: [...candidate.recipients],
        primaryRecipientEmail: candidate.primaryRecipientEmail,
        recipientDeliveryMode: candidate.immutableDeliveryMode ||
          candidate.outreachKind === "follow_up"
          ? candidate.recipientDeliveryMode
          : deliveryMode,
        immutableDeliveryMode: candidate.immutableDeliveryMode,
        parentOutreachId: candidate.outreachKind === "follow_up"
          ? candidate.selectionId.slice("follow_up:".length) : null,
        retryOutreachId: candidate.groupKey.startsWith("retry:")
          ? candidate.groupKey.slice("retry:".length) : null,
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    selectionIds: [...new Set(group.selectionIds)].sort(),
    contactIds: [...new Set(group.contactIds)].sort(),
    coveredArtistIds: [...new Set(group.coveredArtistIds)].sort(),
  })).sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

export function matchesFestivalConfirmedPlan(
  submitted: unknown,
  expected: ReturnType<typeof festivalConfirmedPlan>,
): boolean {
  return JSON.stringify(submitted) === JSON.stringify(expected);
}
