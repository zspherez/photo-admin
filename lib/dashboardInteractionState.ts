import type { MatchedShow } from "@/lib/match";
import { pickEmailContact } from "@/lib/contactSelection";
import {
  getFollowUpEligibilityBatch,
  getOutreachSendabilityBatch,
  type FollowUpEligibility,
  type OutreachSendability,
} from "@/lib/sendOutreach";
import {
  getDashboardRecommendationBadges,
  type DashboardRecommendationBadge,
} from "@/lib/dashboardTrajectoryRecommendations";

export interface DashboardInteractionState {
  sendabilityRows: OutreachSendability[];
  followUpEligibilityRows: FollowUpEligibility[];
  recommendationBadges: DashboardRecommendationBadge[];
}

export async function getDashboardInteractionState(
  shows: readonly MatchedShow[],
  now: Date
): Promise<DashboardInteractionState> {
  const [sendabilityRows, followUpEligibilityRows, recommendationBadges] =
    await Promise.all([
    getOutreachSendabilityBatch(
      shows.flatMap((show) =>
        show.matchedArtists.flatMap((artist) => {
          const contact = pickEmailContact(artist.contacts);
          return contact ? [{ showId: show.id, contactId: contact.id }] : [];
        })
      ),
      now
    ),
    getFollowUpEligibilityBatch(
      shows.flatMap((show) =>
        show.outreach.flatMap((outreach) =>
          outreach.kind === "original" ? [outreach.id] : []
        )
      ),
      now
    ),
    getDashboardRecommendationBadges(shows, now),
  ]);
  return {
    sendabilityRows,
    followUpEligibilityRows,
    recommendationBadges,
  };
}
