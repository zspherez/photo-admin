export type VenueTier = 0 | 1 | 2 | 3;

export const TIER_1_SMALL = [
  "good room",
  "nowadays",
  "public records",
  "elsewhere hall",
  "tba brooklyn",
  "h0l0",
  "le bain",
  "silo",
  "bossa nova civic club",
  "jupiter disco",
  "c'mon everybody",
  "mood ring",
  "sultan room",
  "the sultan room",
  "paragon",
];

export const TIER_2_MID = [
  "house of yes",
  "knockdown center",
  "brooklyn steel",
  "elsewhere",
  "terminal 5",
  "kings hall",
  "avant gardner",
  "brooklyn storehouse",
  "sony hall",
  "racket",
  "market hotel",
  "brooklyn monarch",
  "webster hall",
];

export const TIER_3_MAJOR = [
  "brooklyn mirage",
  "kings theatre",
  "madison square garden",
  "msg",
  "barclays center",
  "radio city",
  "citi field",
  "yankee stadium",
  "met steps",
  "governors island",
];

export const TIER_3_FESTIVALS = [
  "electric zoo",
  "governors ball",
  "ultra",
  "edc",
  "electric daisy carnival",
  "coachella",
  "tomorrowland",
  "electric forest",
  "breakaway",
  "hard summer",
  "day of the dead",
  "sound on sound",
  "time warp",
  "cityfox",
  "teksupport",
];

export interface VenueTierShow {
  date: Date;
  venueName: string;
  eventName: string | null;
}

function includesKeyword(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function containsAnySql(
  value: Prisma.Sql,
  keywords: readonly string[]
): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    keywords.map(
      (keyword) =>
        Prisma.sql`LOWER(COALESCE(${value}, '')) LIKE ${`%${keyword}%`}`
    ),
    " OR "
  )})`;
}

export function venueTierSql(
  venueName: Prisma.Sql,
  eventTitle: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN ${containsAnySql(venueName, TIER_3_FESTIVALS)}
        OR ${containsAnySql(eventTitle, TIER_3_FESTIVALS)}
        THEN 3
      WHEN ${containsAnySql(venueName, TIER_3_MAJOR)} THEN 3
      WHEN ${containsAnySql(venueName, TIER_1_SMALL)} THEN 1
      WHEN ${containsAnySql(venueName, TIER_2_MID)} THEN 2
      ELSE 0
    END
  `;
}

export function classifyVenueTier(
  venueName: string | null | undefined,
  eventTitle: string | null | undefined = ""
): VenueTier {
  const venue = (venueName ?? "").toLowerCase();
  const title = (eventTitle ?? "").toLowerCase();
  if (
    includesKeyword(venue, TIER_3_FESTIVALS) ||
    includesKeyword(title, TIER_3_FESTIVALS)
  ) {
    return 3;
  }
  if (includesKeyword(venue, TIER_3_MAJOR)) return 3;
  if (includesKeyword(venue, TIER_1_SMALL)) return 1;
  if (includesKeyword(venue, TIER_2_MID)) return 2;
  return 0;
}

export function bestVenueTierShow(
  shows: readonly VenueTierShow[]
): VenueTierShow & { tier: VenueTier } | null {
  let best: (VenueTierShow & { tier: VenueTier }) | null = null;
  for (const show of shows) {
    const candidate = {
      ...show,
      tier: classifyVenueTier(show.venueName, show.eventName),
    };
    if (
      !best ||
      candidate.tier > best.tier ||
      (candidate.tier === best.tier && candidate.date < best.date)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function venueTierLabel(tier: VenueTier): string {
  if (tier === 3) return "Tier 3 · major";
  if (tier === 2) return "Tier 2 · mid";
  if (tier === 1) return "Tier 1 · small";
  return "Venue tier unknown";
}
import { Prisma } from "@prisma/client";
