export interface FestivalManagerTarget {
  artistId: string;
  contactId: string;
  email: string;
  recipientDeliveryMode?: "individual_threads" | "cc_thread" | "legacy_multi_to";
}

export interface FestivalManagerGroup {
  email: string;
  contactId: string;
  artistIds: string[];
  recipientDeliveryMode?: "individual_threads" | "cc_thread" | "legacy_multi_to";
}

export function groupFestivalManagerTargets(
  targets: readonly FestivalManagerTarget[],
  sendableContactIds: ReadonlySet<string>,
): { groups: FestivalManagerGroup[]; skipped: number } {
  const grouped = new Map<string, FestivalManagerGroup>();
  let skipped = 0;
  for (const target of [...targets].sort((left, right) =>
    left.artistId.localeCompare(right.artistId),
  )) {
    if (!sendableContactIds.has(target.contactId)) {
      skipped += 1;
      continue;
    }
    const existing = grouped.get(target.email);
    if (existing) {
      existing.artistIds.push(target.artistId);
    } else {
      grouped.set(target.email, {
        email: target.email,
        contactId: target.contactId,
        artistIds: [target.artistId],
        ...(target.recipientDeliveryMode
          ? { recipientDeliveryMode: target.recipientDeliveryMode }
          : {}),
      });
    }
  }
  return { groups: [...grouped.values()], skipped };
}
