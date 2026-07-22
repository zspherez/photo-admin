"use server";

import { revalidatePath } from "next/cache";
import { requireServerActionAuth } from "@/lib/auth";
import {
  deactivatePendingAndClaimedResearchJobs,
  rejectUnresolvedFlaggedAuditDecisions,
} from "@/lib/queueManagement";
import {
  AUDIT_REJECTION_CONFIRMATION,
  QUEUE_DEACTIVATION_CONFIRMATION,
  REVIEW_REQUEUE_CONFIRMATION,
  type QueueManagementActionState,
} from "@/lib/queueManagementContract";
import { retryAllReviewContactResearchJobs } from "@/lib/contactResearch";

function confirmation(formData: FormData): string {
  return String(formData.get("confirmation") ?? "").trim();
}

function actionError(
  operation: string,
  error: unknown,
): QueueManagementActionState {
  console.error(
    JSON.stringify({
      event: "settings_queue_management_failed",
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    status: "error",
    message: "The operation could not be completed. Refresh and try again.",
    affected: null,
  };
}

export async function rejectAuditDecisionsAction(
  _previousState: QueueManagementActionState,
  formData: FormData,
): Promise<QueueManagementActionState> {
  await requireServerActionAuth("/settings/queue-management");
  if (confirmation(formData) !== AUDIT_REJECTION_CONFIRMATION) {
    return {
      status: "error",
      message: `Type ${AUDIT_REJECTION_CONFIRMATION} exactly.`,
      affected: null,
    };
  }
  try {
    const result = await rejectUnresolvedFlaggedAuditDecisions();
    revalidatePath("/contact-audit");
    revalidatePath("/settings");
    revalidatePath("/settings/queue-management");
    return {
      status: "success",
      message:
        `Rejected ${result.rejected.toLocaleString()} unresolved decision(s): ` +
        `${result.changed.toLocaleString()} changed, ` +
        `${result.stale.toLocaleString()} stale, ` +
        `${result.ambiguous.toLocaleString()} ambiguous. Skipped ` +
        `${result.skipped.active_claim.toLocaleString()} active_claim, ` +
        `${result.skipped.contact_changed.toLocaleString()} contact_changed, ` +
        `${result.skipped.contact_missing.toLocaleString()} contact_missing. ` +
        "Contacts and audit evidence were preserved.",
      affected: result.rejected,
    };
  } catch (error) {
    return actionError("reject_audit_decisions", error);
  }
}

export async function requeueReviewResearchAction(
  _previousState: QueueManagementActionState,
  formData: FormData,
): Promise<QueueManagementActionState> {
  await requireServerActionAuth("/settings/queue-management");
  if (confirmation(formData) !== REVIEW_REQUEUE_CONFIRMATION) {
    return {
      status: "error",
      message: `Type ${REVIEW_REQUEUE_CONFIRMATION} exactly.`,
      affected: null,
    };
  }
  try {
    const requeued = await retryAllReviewContactResearchJobs();
    revalidatePath("/research");
    revalidatePath("/settings");
    revalidatePath("/settings/queue-management");
    return {
      status: "success",
      message: `${requeued.toLocaleString()} eligible review job(s) requeued. Ineligible or concurrently changed jobs were left unchanged.`,
      affected: requeued,
    };
  } catch (error) {
    return actionError("requeue_review_research", error);
  }
}

export async function deactivateResearchQueueAction(
  _previousState: QueueManagementActionState,
  formData: FormData,
): Promise<QueueManagementActionState> {
  await requireServerActionAuth("/settings/queue-management");
  if (confirmation(formData) !== QUEUE_DEACTIVATION_CONFIRMATION) {
    return {
      status: "error",
      message: `Type ${QUEUE_DEACTIVATION_CONFIRMATION} exactly.`,
      affected: null,
    };
  }
  try {
    const result = await deactivatePendingAndClaimedResearchJobs();
    revalidatePath("/research");
    revalidatePath("/settings");
    revalidatePath("/settings/queue-management");
    return {
      status: "success",
      message:
        `Deactivated ${result.deactivated.toLocaleString()} queue job(s): ` +
        `${result.pending.toLocaleString()} pending and ` +
        `${result.claimed.toLocaleString()} claimed. All claims were released.`,
      affected: result.deactivated,
    };
  } catch (error) {
    return actionError("deactivate_research_queue", error);
  }
}
