export const AUDIT_REJECTION_CONFIRMATION = "REJECT AUDIT DECISIONS";
export const REVIEW_REQUEUE_CONFIRMATION = "REQUEUE REVIEW RESEARCH";
export const QUEUE_DEACTIVATION_CONFIRMATION =
  "DEACTIVATE RESEARCH QUEUE";

export interface QueueManagementActionState {
  status: "idle" | "success" | "error";
  message: string;
  affected: number | null;
}

export const EMPTY_QUEUE_MANAGEMENT_ACTION_STATE: QueueManagementActionState = {
  status: "idle",
  message: "",
  affected: null,
};
