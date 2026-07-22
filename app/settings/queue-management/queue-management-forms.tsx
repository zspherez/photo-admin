"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import {
  AUDIT_REJECTION_CONFIRMATION,
  EMPTY_QUEUE_MANAGEMENT_ACTION_STATE,
  QUEUE_DEACTIVATION_CONFIRMATION,
  REVIEW_REQUEUE_CONFIRMATION,
  type QueueManagementActionState,
} from "@/lib/queueManagementContract";
import {
  deactivateResearchQueueAction,
  rejectAuditDecisionsAction,
  requeueReviewResearchAction,
} from "./actions";

function Result({ state }: { state: QueueManagementActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={
        state.status === "error"
          ? "mt-3 text-sm text-red-700 dark:text-red-300"
          : "mt-3 text-sm text-emerald-700 dark:text-emerald-300"
      }
    >
      {state.message}
    </p>
  );
}

function ConfirmationField({
  confirmation,
}: {
  confirmation: string;
}) {
  return (
    <div className="mt-4">
      <label className="block text-xs font-medium" htmlFor={confirmation}>
        Type <span className="font-mono">{confirmation}</span> to confirm
      </label>
      <input
        id={confirmation}
        name="confirmation"
        type="text"
        required
        autoComplete="off"
        spellCheck={false}
        className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm shadow-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-500 dark:focus:ring-zinc-800"
      />
    </div>
  );
}

export function QueueManagementForms({
  auditDecisions,
  researchReviews,
  pendingResearchJobs,
  claimedResearchJobs,
}: {
  auditDecisions: number;
  researchReviews: number;
  pendingResearchJobs: number;
  claimedResearchJobs: number;
}) {
  const [auditState, auditAction, auditPending] = useActionState(
    rejectAuditDecisionsAction,
    EMPTY_QUEUE_MANAGEMENT_ACTION_STATE,
  );
  const [reviewState, reviewAction, reviewPending] = useActionState(
    requeueReviewResearchAction,
    EMPTY_QUEUE_MANAGEMENT_ACTION_STATE,
  );
  const [queueState, queueAction, queuePending] = useActionState(
    deactivateResearchQueueAction,
    EMPTY_QUEUE_MANAGEMENT_ACTION_STATE,
  );

  return (
    <div className="mt-6 space-y-4">
      <Card>
        <CardBody>
          <h2 className="font-medium">Reject audit decisions needed</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {auditDecisions.toLocaleString()} unresolved flagged decision(s).
            Marks them rejected without changing contacts or deleting audit
            evidence, alternatives, or roster snapshots.
          </p>
          <form action={auditAction}>
            <ConfirmationField confirmation={AUDIT_REJECTION_CONFIRMATION} />
            <Button
              className="mt-3 w-full sm:w-auto"
              variant="danger"
              disabled={auditPending}
              aria-busy={auditPending}
            >
              {auditPending ? "Rejecting…" : "Reject unresolved decisions"}
            </Button>
          </form>
          <Result state={auditState} />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="font-medium">Requeue research to review</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {researchReviews.toLocaleString()} job(s) currently in review.
            Only still-eligible jobs are returned to pending research; saved
            candidates and evidence remain intact.
          </p>
          <form action={reviewAction}>
            <ConfirmationField confirmation={REVIEW_REQUEUE_CONFIRMATION} />
            <Button
              className="mt-3 w-full sm:w-auto"
              variant="danger"
              disabled={reviewPending}
              aria-busy={reviewPending}
            >
              {reviewPending ? "Requeueing…" : "Requeue eligible review jobs"}
            </Button>
          </form>
          <Result state={reviewState} />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="font-medium">Deactivate the research queue</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {pendingResearchJobs.toLocaleString()} pending and{" "}
            {claimedResearchJobs.toLocaleString()} claimed job(s). Both become
            inactive, and active claims are released. Job history, notes,
            candidates, and evidence are not deleted.
          </p>
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            The hourly contact-research workflow refreshes eligible artists at
            minute 23 and can refill this queue after it is deactivated.
          </p>
          <form action={queueAction}>
            <ConfirmationField
              confirmation={QUEUE_DEACTIVATION_CONFIRMATION}
            />
            <Button
              className="mt-3 w-full sm:w-auto"
              variant="danger"
              disabled={queuePending}
              aria-busy={queuePending}
            >
              {queuePending ? "Deactivating…" : "Deactivate pending and claimed"}
            </Button>
          </form>
          <Result state={queueState} />
        </CardBody>
      </Card>
    </div>
  );
}
