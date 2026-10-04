import type { RecipientDeliveryMode } from "@/lib/recipientDelivery";
import { normalizeEmail } from "@/lib/resend";

export interface FestivalManagerTarget {
  artistId: string;
  contactId: string;
  email: string;
  recipientDeliveryMode?: RecipientDeliveryMode;
}

export interface FestivalManagerGroup {
  email: string;
  contactId: string;
  artistIds: string[];
  recipientDeliveryMode?: RecipientDeliveryMode;
}

export function uniqueFestivalRecipientTargets(
  artists: readonly {
    artistId: string;
    contacts: readonly {
      id: string;
      email: string | null;
      state: string;
    }[];
  }[],
): FestivalManagerTarget[] {
  return artists.flatMap(({ artistId, contacts }) => {
    const seen = new Set<string>();
    return contacts.flatMap((contact) => {
      const email = normalizeEmail(contact.email ?? "");
      if (contact.state !== "active" || !email || seen.has(email)) return [];
      seen.add(email);
      return [{ artistId, contactId: contact.id, email }];
    });
  });
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

export function sharedFestivalManagementArtistIds(
  targets: readonly FestivalManagerTarget[],
): Set<string> {
  const { groups } = groupFestivalManagerTargets(
    targets,
    new Set(targets.map((target) => target.contactId)),
  );
  return new Set(
    groups
      .filter((group) => new Set(group.artistIds).size > 1)
      .flatMap((group) => group.artistIds),
  );
}
