export type TrajectoryRecommendationArm =
  | "trajectory"
  | "momentum"
  | "exploration"
  | "portfolio";

export interface AnalogSummaryView {
  names: string[];
  positiveNeighbors: number;
  neighborCount: number;
  poolBaseRatePercent: number;
}

export type ContactCategory =
  | "ready_email"
  | "needs_email"
  | "direct_outreach"
  | "email_blocked";

export interface RecommendationView {
  id: string;
  identityKey: string;
  showId: string;
  showDate: string;
  venueName: string;
  location: string;
  ticketUrl: string | null;
  eventName: string | null;
  artistId: string;
  artistName: string;
  arm: TrajectoryRecommendationArm;
  listRank: number;
  isSuggested: boolean;
  slatePosition: number | null;
  billingPosition: number;
  lineupSize: number;
  isFirstBilled: boolean;
  interested: boolean;
  dismissed: boolean;
  contactCategory: ContactCategory;
  contactLabel: string;
  contactDetail: string | null;
  outreachLabels: string[];
  rationale: string[];
  analogSummary: AnalogSummaryView | null;
  details: {
    coverageState: string;
    momentumBand: string | null;
    eventDelta6m: number | null;
    eventsPrior6m: number | null;
    eventsRecent6m: number | null;
    marketsPrior6m: number | null;
    marketsRecent6m: number | null;
    careerAgeYears: number | null;
    genres: string[];
    releaseContext: unknown;
  };
}

export interface RecommendationDateGroup {
  date: string;
  recommendations: Array<
    RecommendationView & {
      sameNightRole: "primary" | "backup";
      accessState: "not_recorded";
    }
  >;
}

export function groupRecommendationsByDate(
  recommendations: readonly RecommendationView[],
): RecommendationDateGroup[] {
  const groups = new Map<string, RecommendationView[]>();
  for (const recommendation of recommendations) {
    const date = recommendation.showDate.slice(0, 10);
    const rows = groups.get(date) ?? [];
    rows.push(recommendation);
    groups.set(date, rows);
  }
  return [...groups.entries()].map(([date, rows]) => {
    const showOrder = [...new Set(rows.map((row) => row.showId))];
    return {
      date,
      recommendations: rows.map((row) => ({
        ...row,
        sameNightRole:
          showOrder.indexOf(row.showId) === 0 ? "primary" : "backup",
        accessState: "not_recorded",
      })),
    };
  });
}
