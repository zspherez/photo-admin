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

export interface TrajectoryDecisionView {
  id: string;
  action: "selected" | "declined" | "saved" | "dismissed" | "manual_override";
  propensity: number | null;
  manualOverride: boolean;
  notes: string | null;
  supersedesId: string | null;
  recordedAt: string;
  isCurrent: boolean;
}

export interface TrajectoryOutcomeView {
  id: string;
  attended: boolean | null;
  access: "none" | "guestlist" | "photo_pass" | "other" | null;
  keeperCount: number | null;
  relationshipValue: number | null;
  publicationValue: number | null;
  shootability: "good" | "ok" | "poor" | null;
  venueAccessibility: "high" | "medium" | "low" | null;
  notes: string | null;
  supersedesId: string | null;
  recordedAt: string;
  isCurrent: boolean;
}

export interface RecommendationView {
  id: string;
  runId: string;
  trajectoryActionId: string;
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
  emailContact: {
    id: string;
    name: string | null;
  } | null;
  phoneContact: {
    phone: string;
    name: string | null;
  } | null;
  contactId: string | null;
  sendability: {
    sendable: boolean;
    mode: "new" | "retry" | null;
    reason: string | null;
    blockingOutreachId: string | null;
    blockingStatus: string | null;
    blockingNextAttemptAt: string | null;
  } | null;
  alreadySent: boolean;
  scheduledInfo: {
    outreachId: string;
    scheduledLabel: string;
  } | null;
  followUpEligibility: {
    parentOutreachId: string;
    eligible: boolean;
    state: "eligible" | "pending" | "sent" | "blocked";
    mode: "new" | "retry" | null;
    reason: string | null;
    recipients: string[];
    fullTeamSend: boolean;
    followUpOutreachId?: string;
    followUpStatus?: string;
    nextAttemptAt?: string;
  } | null;
  canMarkManually: boolean;
  manualMarkerId: string | null;
  workflowPriority: {
    rank: number;
    label: string;
  };
  framingLabel: string;
  outreachLabels: string[];
  decisionHistory: TrajectoryDecisionView[];
  outcomeHistory: TrajectoryOutcomeView[];
  outcomeRecordable: boolean;
  outcomeRecordabilityMessage: string | null;
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
