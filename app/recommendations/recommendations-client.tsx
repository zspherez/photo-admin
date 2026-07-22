"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtistLink } from "@/components/artist-modal";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SendButton } from "@/components/send-button";
import { FollowUpButton } from "@/components/follow-up-button";
import { cn } from "@/lib/cn";
import { formatShowDate } from "@/lib/formatDate";
import { mergeUniqueByKey } from "@/lib/dashboardInfinite";
import {
  buildRecommendationBatchHref,
  buildRecommendationHref,
  recommendationQueryWith,
  type RecommendationDateBand,
  type RecommendationQuery,
  type RecommendationTab,
  type RecommendationWorkflow,
} from "@/lib/trajectoryRecommendationQuery";
import {
  groupRecommendationsByDate,
  type RecommendationView,
} from "@/lib/trajectoryRecommendationView";
import { withWorkflowReturnTo } from "@/lib/workflowLinks";
import {
  cancelScheduledAction,
  dismissShowAction,
  markSentAction,
  restoreShowAction,
  sendFollowUpAction,
  sendNowAction,
  setInterestedAction,
  unmarkSentAction,
} from "@/app/dashboard/actions";
import {
  recordTrajectoryFeedbackAction,
  recordTrajectoryOutcomeAction,
} from "./actions";

const TABS: Array<{ value: RecommendationTab; label: string }> = [
  { value: "suggested", label: "Suggested slate" },
  { value: "trajectory", label: "Trajectory" },
  { value: "exploration", label: "Exploration" },
  { value: "portfolio", label: "Portfolio" },
  { value: "momentum", label: "Broader momentum" },
];

const WORKFLOWS: Array<{
  value: RecommendationWorkflow;
  label: string;
}> = [
  { value: "all", label: "All workflow states" },
  { value: "ready", label: "Ready to contact" },
  { value: "needs", label: "Needs contact" },
  { value: "direct", label: "Direct outreach" },
  { value: "interested", label: "Interested" },
  { value: "sent", label: "Sent / scheduled" },
  { value: "opened", label: "Opened" },
  { value: "clicked", label: "Clicked" },
  { value: "dismissed", label: "Dismissed" },
];

const DATE_BANDS: Array<{
  value: RecommendationDateBand;
  label: string;
  description: string;
}> = [
  { value: "all", label: "All 5–90 days", description: "Entire planning horizon" },
  { value: "5-10", label: "5–10 days", description: "Review/listen; short lead" },
  { value: "10-45", label: "10–45 days", description: "Normal outreach window" },
  { value: "45-90", label: "45–90 days", description: "Later planning" },
];

interface BatchPayload {
  recommendations: RecommendationView[];
  nextCursor: string | null;
}

const FEEDBACK_INPUT_CLASS =
  "mt-1 block min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-950";

function evidenceTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function decisionLabel(action: RecommendationView["decisionHistory"][number]["action"]): string {
  return action === "manual_override"
    ? "Manual override"
    : action.replaceAll("_", " ");
}

function outcomeSummary(
  outcome: RecommendationView["outcomeHistory"][number],
): string {
  const parts = [
    outcome.attended === null
      ? null
      : outcome.attended
        ? "Attended"
        : "Did not attend",
    outcome.access ? `Access: ${outcome.access.replaceAll("_", " ")}` : null,
    outcome.keeperCount === null ? null : `${outcome.keeperCount} keepers`,
    outcome.relationshipValue === null
      ? null
      : `Relationship ${outcome.relationshipValue}/2`,
    outcome.publicationValue === null
      ? null
      : `Publication ${outcome.publicationValue}/2`,
    outcome.shootability ? `Shootability: ${outcome.shootability}` : null,
    outcome.venueAccessibility
      ? `Venue access: ${outcome.venueAccessibility}`
      : null,
  ].filter((value): value is string => value !== null);
  return parts.join(" · ");
}

type FeedbackRecommendation = Pick<
  RecommendationView,
  | "id"
  | "runId"
  | "showId"
  | "artistId"
  | "trajectoryActionId"
  | "decisionHistory"
  | "outcomeHistory"
  | "outcomeRecordable"
  | "outcomeRecordabilityMessage"
>;

export function RecommendationFeedbackPanel({
  recommendation,
  returnTo,
  outcomeOnly = false,
}: {
  recommendation: FeedbackRecommendation;
  returnTo: string;
  outcomeOnly?: boolean;
}) {
  const currentDecision = recommendation.decisionHistory.find(
    (item) => item.isCurrent,
  );
  const currentOutcome = recommendation.outcomeHistory.find(
    (item) => item.isCurrent,
  );
  const attributionFields = [
    { name: "recommendationId", value: recommendation.id },
    { name: "runId", value: recommendation.runId },
    { name: "showId", value: recommendation.showId },
    { name: "artistId", value: recommendation.artistId },
    { name: "returnTo", value: returnTo },
  ];

  return (
    <details className="rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-semibold">
        {outcomeOnly ? "Show outcome" : "Decision & show outcome"}
      </summary>
      <div className="mt-4 space-y-6">
        {!outcomeOnly && (
          <section aria-labelledby={`decision-${recommendation.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id={`decision-${recommendation.id}`} className="text-sm font-semibold">
              Decision
            </h4>
            {currentDecision ? (
              <Badge tone="info">
                Latest: {decisionLabel(currentDecision.action)}
              </Badge>
            ) : (
              <Badge tone="muted">Not recorded</Badge>
            )}
          </div>
          <form
            action={recordTrajectoryFeedbackAction}
            className="mt-3 space-y-3"
          >
            {attributionFields.map((field) => (
              <input key={field.name} type="hidden" {...field} />
            ))}
            <input
              type="hidden"
              name="idempotencyKey"
              value={`trajectory-feedback/${recommendation.trajectoryActionId}`}
            />
            {currentDecision && (
              <input
                type="hidden"
                name="supersedesId"
                value={currentDecision.id}
              />
            )}
            <div>
              <label
                htmlFor={`decision-notes-${recommendation.id}`}
                className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
              >
                Optional private note
              </label>
              <textarea
                id={`decision-notes-${recommendation.id}`}
                name="notes"
                rows={2}
                maxLength={4000}
                defaultValue={currentDecision?.notes ?? ""}
                className={FEEDBACK_INPUT_CLASS}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <PendingSubmitButton
                name="action"
                value="selected"
                size="sm"
                className="min-h-10"
                pendingLabel="Saving…"
              >
                Selected
              </PendingSubmitButton>
              <PendingSubmitButton
                name="action"
                value="saved"
                variant="secondary"
                size="sm"
                className="min-h-10"
                pendingLabel="Saving…"
              >
                Saved
              </PendingSubmitButton>
              <PendingSubmitButton
                name="action"
                value="declined"
                variant="secondary"
                size="sm"
                className="min-h-10"
                pendingLabel="Saving…"
              >
                Declined
              </PendingSubmitButton>
              <PendingSubmitButton
                name="action"
                value="manual_override"
                variant="secondary"
                size="sm"
                className="min-h-10"
                pendingLabel="Saving…"
              >
                Manual override
              </PendingSubmitButton>
            </div>
          </form>
          {recommendation.decisionHistory.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
                Decision correction history ({recommendation.decisionHistory.length})
              </summary>
              <ol className="mt-2 space-y-2">
                {recommendation.decisionHistory.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                  >
                    <span className="font-medium">
                      {decisionLabel(item.action)}
                    </span>{" "}
                    · {evidenceTimestamp(item.recordedAt)}
                    {item.isCurrent ? " · current" : " · corrected"}
                    {item.notes && (
                      <p className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
                        Private note: {item.notes}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          </section>
        )}

        <section
          aria-labelledby={`outcome-${recommendation.id}`}
          className={
            outcomeOnly
              ? undefined
              : "border-t border-zinc-200 pt-5 dark:border-zinc-800"
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id={`outcome-${recommendation.id}`} className="text-sm font-semibold">
              Attendance, access &amp; photo outcome
            </h4>
            {currentOutcome ? (
              <Badge tone="success">Latest outcome recorded</Badge>
            ) : (
              <Badge tone="muted">Not recorded</Badge>
            )}
          </div>
          <form
            action={recordTrajectoryOutcomeAction}
            className="mt-3 space-y-3"
          >
            {attributionFields.map((field) => (
              <input key={field.name} type="hidden" {...field} />
            ))}
            <input
              type="hidden"
              name="idempotencyKey"
              value={`trajectory-outcome/${recommendation.trajectoryActionId}`}
            />
            {currentOutcome && (
              <input
                type="hidden"
                name="supersedesId"
                value={currentOutcome.id}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium">
                Attended
                <select
                  name="attended"
                  required
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={
                    currentOutcome?.attended === true
                      ? "true"
                      : currentOutcome?.attended === false
                        ? "false"
                        : ""
                  }
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                Access
                <select
                  name="access"
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.access ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="">Not recorded</option>
                  <option value="none">None</option>
                  <option value="guestlist">Guest list</option>
                  <option value="photo_pass">Photo pass</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                Keeper count
                <input
                  name="keeperCount"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.keeperCount ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                />
              </label>
              <label className="text-xs font-medium">
                Relationship value
                <select
                  name="relationshipValue"
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.relationshipValue ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="">Not recorded</option>
                  <option value="0">0 — none</option>
                  <option value="1">1 — some</option>
                  <option value="2">2 — strong</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                Publication value
                <select
                  name="publicationValue"
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.publicationValue ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="">Not recorded</option>
                  <option value="0">0 — none</option>
                  <option value="1">1 — some</option>
                  <option value="2">2 — strong</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                Shootability
                <select
                  name="shootability"
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.shootability ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="">Not recorded</option>
                  <option value="good">Good</option>
                  <option value="ok">OK</option>
                  <option value="poor">Poor</option>
                </select>
              </label>
              <label className="text-xs font-medium">
                Venue accessibility
                <select
                  name="venueAccessibility"
                  disabled={!recommendation.outcomeRecordable}
                  defaultValue={currentOutcome?.venueAccessibility ?? ""}
                  className={FEEDBACK_INPUT_CLASS}
                >
                  <option value="">Not recorded</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            </div>
            <div>
              <label
                htmlFor={`outcome-notes-${recommendation.id}`}
                className="text-xs font-medium"
              >
                Optional private note
              </label>
              <textarea
                id={`outcome-notes-${recommendation.id}`}
                name="notes"
                rows={2}
                maxLength={4000}
                disabled={!recommendation.outcomeRecordable}
                defaultValue={currentOutcome?.notes ?? ""}
                className={FEEDBACK_INPUT_CLASS}
              />
            </div>
            <PendingSubmitButton
              size="sm"
              className="min-h-10 w-full sm:w-auto"
              pendingLabel="Saving outcome…"
              disabled={!recommendation.outcomeRecordable}
            >
              {currentOutcome ? "Save outcome correction" : "Save outcome"}
            </PendingSubmitButton>
          </form>
          {recommendation.outcomeRecordabilityMessage && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {recommendation.outcomeRecordabilityMessage}
            </p>
          )}
          {recommendation.outcomeHistory.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
                Outcome correction history ({recommendation.outcomeHistory.length})
              </summary>
              <ol className="mt-2 space-y-2">
                {recommendation.outcomeHistory.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900"
                  >
                    <span className="font-medium">{outcomeSummary(item)}</span>
                    <br />
                    {evidenceTimestamp(item.recordedAt)}
                    {item.isCurrent ? " · current" : " · corrected"}
                    {item.notes && (
                      <p className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
                        Private note: {item.notes}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="mt-2 text-xs text-zinc-500">
            Notes stay in photo-admin and are never included in the producer export.
          </p>
        </section>
      </div>
    </details>
  );
}

function armTone(arm: RecommendationView["arm"]): BadgeTone {
  if (arm === "trajectory") return "accent";
  if (arm === "momentum") return "info";
  if (arm === "portfolio") return "success";
  return "warning";
}

function contactTone(
  category: RecommendationView["contactCategory"],
): BadgeTone {
  if (category === "ready_email") return "success";
  if (category === "direct_outreach") return "info";
  if (category === "needs_email") return "warning";
  return "danger";
}

function RecommendationCard({
  recommendation,
  role,
  returnTo,
  isWeekend,
}: {
  recommendation: RecommendationView;
  role: "primary" | "backup";
  returnTo: string;
  isWeekend: boolean;
}) {
  const hiddenFields = [
    { name: "recommendationId", value: recommendation.id },
    { name: "runId", value: recommendation.runId },
    { name: "artistId", value: recommendation.artistId },
    {
      name: "trajectoryActionId",
      value: recommendation.trajectoryActionId,
    },
  ];
  const sendability = recommendation.sendability;
  const isScheduled = recommendation.scheduledInfo !== null;
  const emailDisabledLabel =
    recommendation.emailContact &&
    !isScheduled &&
    (!sendability || !sendability.sendable)
      ? sendability?.blockingStatus === "queued"
        ? "In progress"
        : sendability?.blockingStatus === "retry_scheduled"
          ? "Retry scheduled"
          : sendability?.blockingStatus === "manual_review"
            ? "Review"
            : "Unavailable"
      : undefined;
  const followUpEligibility = recommendation.followUpEligibility
    ? {
        parentOutreachId:
          recommendation.followUpEligibility.parentOutreachId,
        eligible: recommendation.followUpEligibility.eligible,
        state: recommendation.followUpEligibility.state,
        mode: recommendation.followUpEligibility.mode,
        reason: recommendation.followUpEligibility.reason,
        recipients: recommendation.followUpEligibility.recipients,
        fullTeamSend: recommendation.followUpEligibility.fullTeamSend,
        followUpOutreachId:
          recommendation.followUpEligibility.followUpOutreachId,
        followUpStatus: recommendation.followUpEligibility.followUpStatus,
        nextAttemptAt: recommendation.followUpEligibility.nextAttemptAt
          ? new Date(recommendation.followUpEligibility.nextAttemptAt)
          : undefined,
      }
    : null;
  const customizeHref = recommendation.emailContact
    ? (() => {
        const href = withWorkflowReturnTo(
          `/dashboard/customize/${recommendation.showId}/${recommendation.emailContact.id}`,
          returnTo,
        );
        const url = new URL(href, "https://recommendations.local");
        url.searchParams.set("recommendationId", recommendation.id);
        url.searchParams.set("runId", recommendation.runId);
        url.searchParams.set("artistId", recommendation.artistId);
        return `${url.pathname}${url.search}`;
      })()
    : null;

  return (
    <Card
      id={`recommendation-${recommendation.id}`}
      data-recommendation-identity={recommendation.identityKey}
    >
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={role === "primary" ? "accent" : "muted"}>
                {role === "primary" ? "Primary option" : "Backup option"}
              </Badge>
              <Badge tone={armTone(recommendation.arm)}>
                {recommendation.arm === "momentum"
                  ? "Broader momentum"
                  : recommendation.arm}
              </Badge>
              <Badge tone="muted">
                Workflow priority #{recommendation.workflowPriority.rank} ·{" "}
                {recommendation.workflowPriority.label}
              </Badge>
              {recommendation.slatePosition && (
                <Badge tone="default">
                  Slate #{recommendation.slatePosition}
                </Badge>
              )}
              <Badge tone="muted">{recommendation.framingLabel}</Badge>
            </div>
            <h3 className="mt-2 text-lg font-semibold">
              <ArtistLink
                artistId={recommendation.artistId}
                returnTo={returnTo}
              >
                {recommendation.artistName}
              </ArtistLink>
            </h3>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {formatShowDate(recommendation.showDate, {
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {recommendation.venueName}
              {recommendation.location ? ` · ${recommendation.location}` : ""}
            </p>
            {recommendation.eventName && (
              <p className="mt-1 text-xs text-zinc-500">
                {recommendation.eventName}
              </p>
            )}
          </div>
          {recommendation.ticketUrl && (
            <LinkButton
              href={recommendation.ticketUrl}
              target="_blank"
              rel="noreferrer"
              variant="secondary"
              size="sm"
            >
              Tickets
            </LinkButton>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge tone="muted">
            Billing {recommendation.billingPosition}/{recommendation.lineupSize}
          </Badge>
          {recommendation.isFirstBilled && (
            <Badge tone="accent">First billed</Badge>
          )}
          <Badge tone={contactTone(recommendation.contactCategory)}>
            {recommendation.contactLabel}
          </Badge>
          {recommendation.interested && <Badge tone="success">Interested</Badge>}
          {recommendation.dismissed && <Badge tone="muted">Dismissed</Badge>}
          {recommendation.outreachLabels.map((label) => (
            <Badge key={label} tone={label === "No outreach" ? "muted" : "info"}>
              {label}
            </Badge>
          ))}
          {recommendation.outcomeHistory.find((item) => item.isCurrent)?.access ? (
            <Badge tone="success">
              Access:{" "}
              {recommendation.outcomeHistory
                .find((item) => item.isCurrent)
                ?.access?.replaceAll("_", " ")}
            </Badge>
          ) : (
            <Badge tone="muted">Access not recorded</Badge>
          )}
        </div>

        {recommendation.contactDetail && (
          <p className="break-words text-sm">
            <span className="font-medium">Contact:</span>{" "}
            {recommendation.contactDetail}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(recommendation.emailContact || recommendation.phoneContact) && (
            <SendButton
              showId={recommendation.showId}
              contactId={recommendation.emailContact?.id ?? null}
              contactName={recommendation.emailContact?.name ?? null}
              phone={recommendation.phoneContact?.phone ?? null}
              phoneContactName={recommendation.phoneContact?.name ?? null}
              alreadySent={recommendation.alreadySent}
              emailDisabledLabel={emailDisabledLabel}
              emailDisabledReason={sendability?.reason ?? undefined}
              isRetry={sendability?.mode === "retry"}
              isWeekend={isWeekend}
              scheduledInfo={recommendation.scheduledInfo}
              returnTo={returnTo}
              action={sendNowAction}
              cancelAction={cancelScheduledAction}
              hiddenFields={hiddenFields}
            />
          )}
          {customizeHref && sendability?.mode !== "retry" && (
            <LinkButton href={customizeHref} variant="secondary" size="sm">
              Customize
            </LinkButton>
          )}
          {recommendation.contactCategory === "needs_email" && (
            <>
              <LinkButton
                href={withWorkflowReturnTo(
                  `/dashboard/add-contact/${recommendation.artistId}`,
                  returnTo,
                )}
                variant="secondary"
                size="sm"
              >
                Add contact
              </LinkButton>
              <LinkButton
                href={withWorkflowReturnTo(
                  `/artists/${recommendation.artistId}`,
                  returnTo,
                )}
                variant="secondary"
                size="sm"
              >
                Research contact
              </LinkButton>
            </>
          )}
          {recommendation.contactCategory === "direct_outreach" && (
            <LinkButton
              href={withWorkflowReturnTo(
                `/artists/${recommendation.artistId}`,
                returnTo,
              )}
              variant="secondary"
              size="sm"
            >
              Review direct outreach
            </LinkButton>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-900">
          <form action={setInterestedAction}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="showId" value={recommendation.showId} />
            <input
              type="hidden"
              name="interested"
              value={recommendation.interested ? "false" : "true"}
            />
            {hiddenFields.map((field) => (
              <input key={field.name} type="hidden" {...field} />
            ))}
            <PendingSubmitButton
              variant={recommendation.interested ? "secondary" : "primary"}
              size="sm"
              pendingLabel="Saving…"
            >
              {recommendation.interested
                ? "Remove interested"
                : "Mark interested"}
            </PendingSubmitButton>
          </form>
          <form
            action={
              recommendation.dismissed ? restoreShowAction : dismissShowAction
            }
          >
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="showId" value={recommendation.showId} />
            {hiddenFields.map((field) => (
              <input key={field.name} type="hidden" {...field} />
            ))}
            <PendingSubmitButton
              variant="secondary"
              size="sm"
              pendingLabel="Saving…"
            >
              {recommendation.dismissed ? "Restore" : "Dismiss"}
            </PendingSubmitButton>
          </form>
          {followUpEligibility && recommendation.emailContact && (
            <FollowUpButton
              eligibility={followUpEligibility}
              returnTo={returnTo}
              isWeekend={isWeekend}
              action={sendFollowUpAction}
              cancelAction={cancelScheduledAction}
              showId={recommendation.showId}
              hiddenFields={hiddenFields}
            />
          )}
          {recommendation.canMarkManually && (
            <form action={markSentAction}>
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="showId" value={recommendation.showId} />
              {recommendation.contactId ? (
                <input
                  type="hidden"
                  name="contactId"
                  value={recommendation.contactId}
                />
              ) : (
                <input
                  type="hidden"
                  name="artistId"
                  value={recommendation.artistId}
                />
              )}
              {hiddenFields.map((field) => (
                <input key={field.name} type="hidden" {...field} />
              ))}
              <PendingSubmitButton
                variant="ghost"
                size="sm"
                pendingLabel="Marking…"
              >
                Mark sent (manual)
              </PendingSubmitButton>
            </form>
          )}
          {recommendation.manualMarkerId && (
            <form action={unmarkSentAction}>
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="showId" value={recommendation.showId} />
              <input
                type="hidden"
                name="outreachId"
                value={recommendation.manualMarkerId}
              />
              {hiddenFields.map((field) => (
                <input key={field.name} type="hidden" {...field} />
              ))}
              <PendingSubmitButton
                variant="ghost"
                size="sm"
                pendingLabel="Unmarking…"
              >
                Unmark sent
              </PendingSubmitButton>
            </form>
          )}
        </div>

        <RecommendationFeedbackPanel
          recommendation={recommendation}
          returnTo={returnTo}
        />

        <div>
          <h4 className="text-sm font-semibold">Why it is here</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {recommendation.rationale.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>

        {recommendation.analogSummary && (
          <div className="rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold">Nearest historical analogs</h4>
              <span
                className="cursor-help text-xs text-zinc-500 underline decoration-dotted"
                title="Descriptive historical comparison only, not a probability or forecast."
              >
                descriptive, not probability
              </span>
            </div>
            <p className="mt-1">
              {recommendation.analogSummary.names.length > 0
                ? recommendation.analogSummary.names.join(", ")
                : "No analog names available"}
            </p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {recommendation.analogSummary.positiveNeighbors} of{" "}
              {recommendation.analogSummary.neighborCount} nearest comparisons
              had sustained expansion. Historical pool base rate (descriptive):{" "}
              {recommendation.analogSummary.poolBaseRatePercent}%.
            </p>
          </div>
        )}

        <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
          <summary className="cursor-pointer font-medium">Details</summary>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Model list order</dt>
              <dd>#{recommendation.listRank}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Coverage state</dt>
              <dd>{recommendation.details.coverageState}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Momentum band</dt>
              <dd>{recommendation.details.momentumBand ?? "Not available"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Completed bookings</dt>
              <dd>
                {recommendation.details.eventsPrior6m ?? "—"} →{" "}
                {recommendation.details.eventsRecent6m ?? "—"} (
                {recommendation.details.eventDelta6m ?? "—"})
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Markets</dt>
              <dd>
                {recommendation.details.marketsPrior6m ?? "—"} →{" "}
                {recommendation.details.marketsRecent6m ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Career age</dt>
              <dd>
                {recommendation.details.careerAgeYears === null
                  ? "Not available"
                  : `${recommendation.details.careerAgeYears} years`}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Genres</dt>
              <dd>
                {recommendation.details.genres.length > 0
                  ? recommendation.details.genres.join(", ")
                  : "Not available"}
              </dd>
            </div>
          </dl>
          <pre className="mt-3 max-h-52 overflow-auto rounded bg-zinc-950 p-2 text-[11px] text-zinc-100">
            {JSON.stringify(recommendation.details.releaseContext, null, 2)}
          </pre>
        </details>
      </CardBody>
    </Card>
  );
}

export function RecommendationsClient({
  initialRecommendations,
  initialNextCursor,
  total,
  query,
  isWeekend,
  dashboardReturnTo,
}: {
  initialRecommendations: RecommendationView[];
  initialNextCursor: string | null;
  total: number;
  query: RecommendationQuery;
  isWeekend: boolean;
  dashboardReturnTo: string | null;
}) {
  const [recommendations, setRecommendations] = useState(
    initialRecommendations,
  );
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const groups = useMemo(
    () => groupRecommendationsByDate(recommendations),
    [recommendations],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        buildRecommendationBatchHref(query, nextCursor),
        { headers: { Accept: "application/json" } },
      );
      if (response.status === 410) {
        setNextCursor(null);
        setError("The active recommendation run changed or expired. Refresh.");
        return;
      }
      if (!response.ok) throw new Error("Could not load recommendations");
      const payload = (await response.json()) as BatchPayload;
      const merged = mergeUniqueByKey(
        recommendations,
        payload.recommendations,
        (item) => item.identityKey,
      );
      setRecommendations(merged.items);
      setAnnouncement(
        `Loaded ${merged.added} more recommendation${merged.added === 1 ? "" : "s"}.`,
      );
      setNextCursor(payload.nextCursor);
    } catch {
      setError("Couldn’t load more recommendations.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextCursor, query, recommendations]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !nextCursor || !("IntersectionObserver" in window)) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (reducedMotion || connection?.saveData) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  return (
    <section className="mt-6" aria-labelledby="recommendation-results">
      <nav
        aria-label="Recommendation arms"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            href={buildRecommendationHref(
              recommendationQueryWith(query, { tab: tab.value }),
              "/recommendations",
              dashboardReturnTo,
            )}
            aria-current={query.tab === tab.value ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium",
              query.tab === tab.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Workflow
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {WORKFLOWS.map((workflow) => (
              <Link
                key={workflow.value}
                href={buildRecommendationHref(
                  recommendationQueryWith(query, {
                    workflow: workflow.value,
                  }),
                  "/recommendations",
                  dashboardReturnTo,
                )}
                aria-current={
                  query.workflow === workflow.value ? "true" : undefined
                }
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  query.workflow === workflow.value
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                )}
              >
                {workflow.label}
              </Link>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Show date
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DATE_BANDS.map((band) => (
              <Link
                key={band.value}
                href={buildRecommendationHref(
                  recommendationQueryWith(query, { dateBand: band.value }),
                  "/recommendations",
                  dashboardReturnTo,
                )}
                title={band.description}
                aria-current={query.dateBand === band.value ? "true" : undefined}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  query.dateBand === band.value
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                )}
              >
                {band.label}
              </Link>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <h2 id="recommendation-results" className="text-lg font-semibold">
          {total} recommendation{total === 1 ? "" : "s"}
        </h2>
        <p className="text-xs text-zinc-500">
          Showing {recommendations.length}
        </p>
      </div>

      {groups.length === 0 ? (
        <Card className="mt-3">
          <CardBody>
            <p className="font-medium">No recommendations match these filters.</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Try another arm, workflow state, or date band.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="mt-3 space-y-8">
          {groups.map((group) => (
            <section key={group.date} aria-labelledby={`date-${group.date}`}>
              <div className="mb-3 flex items-center gap-3">
                <h3
                  id={`date-${group.date}`}
                  className="text-base font-semibold"
                >
                  {formatShowDate(`${group.date}T00:00:00.000Z`, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </h3>
                {new Set(group.recommendations.map((row) => row.showId)).size >
                  1 && <Badge tone="info">Same-night alternatives</Badge>}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {group.recommendations.map((recommendation) => (
                  <RecommendationCard
                    key={recommendation.identityKey}
                    recommendation={recommendation}
                    role={recommendation.sameNightRole}
                    returnTo={buildRecommendationHref(
                      query,
                      "/recommendations",
                      dashboardReturnTo,
                    )}
                    isWeekend={isWeekend}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="mt-6 flex min-h-10 justify-center">
        {nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : recommendations.length > 0 ? (
          <p className="text-sm text-zinc-500">You’ve reached the end.</p>
        ) : null}
      </div>
      {error && (
        <p className="mt-2 text-center text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
