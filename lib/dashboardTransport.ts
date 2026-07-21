import type { MatchedShow } from "@/lib/match";
import type {
  FollowUpEligibility,
  OutreachSendability,
} from "@/lib/sendOutreach";

type Jsonify<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Jsonify<Item>[]
    : T extends object
      ? { [Key in keyof T]: Jsonify<T[Key]> }
      : T;

export interface DashboardAppendPayload {
  shows: MatchedShow[];
  nextCursor: string | null;
  sendabilityRows: OutreachSendability[];
  followUpEligibilityRows: FollowUpEligibility[];
}

export type DashboardAppendJson = Jsonify<DashboardAppendPayload>;

export function serializeDashboardAppendPayload(
  payload: DashboardAppendPayload
): DashboardAppendJson {
  return JSON.parse(JSON.stringify(payload)) as DashboardAppendJson;
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function deserializeDashboardAppendPayload(
  payload: DashboardAppendJson
): DashboardAppendPayload {
  return {
    shows: payload.shows.map((show) => ({
      ...show,
      date: new Date(show.date),
      dismissedAt: dateOrNull(show.dismissedAt),
      interestedAt: dateOrNull(show.interestedAt),
      outreach: show.outreach.map((outreach) => ({
        ...outreach,
        sentAt: dateOrNull(outreach.sentAt),
        deliveredAt: dateOrNull(outreach.deliveredAt),
        scheduledFor: dateOrNull(outreach.scheduledFor),
        nextAttemptAt: dateOrNull(outreach.nextAttemptAt),
      })),
    })),
    nextCursor: payload.nextCursor,
    sendabilityRows: payload.sendabilityRows.map(
      ({ blockingNextAttemptAt, ...row }) => ({
        ...row,
        ...(blockingNextAttemptAt
          ? { blockingNextAttemptAt: new Date(blockingNextAttemptAt) }
          : {}),
      })
    ),
    followUpEligibilityRows: payload.followUpEligibilityRows.map(
      ({ nextAttemptAt, ...row }) => ({
        ...row,
        ...(nextAttemptAt
          ? { nextAttemptAt: new Date(nextAttemptAt) }
          : {}),
      })
    ),
  };
}
