"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireServerActionAuth } from "@/lib/auth";
import {
  appendWorkflowResult,
  workflowReturnPath,
} from "@/lib/dashboardReturnUrl";
import {
  attributeTrajectoryOutreach,
  recordTrajectoryFeedback,
  recordTrajectoryOutcome,
  TrajectoryFeedbackError,
} from "@/lib/trajectoryFeedback";
import {
  executeTrajectoryFeedbackAction,
  executeTrajectoryOutcomeAction,
  executeTrajectoryOutreachAttributionAction,
} from "@/lib/trajectoryFeedbackActions";

function dependencies() {
  return {
    authorize: async () => {},
    recordFeedback: recordTrajectoryFeedback,
    recordOutcome: recordTrajectoryOutcome,
    attributeOutreach: attributeTrajectoryOutreach,
    refresh: () => revalidatePath("/recommendations"),
  };
}

function actionErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invalid trajectory feedback";
  }
  if (error instanceof TrajectoryFeedbackError) return error.message;
  console.error("Trajectory feedback action failed", error);
  return "Could not save trajectory feedback";
}

async function authenticatedAction(
  formData: FormData,
  execute: (formData: FormData) => Promise<void>,
  successKey: "decision_saved" | "outcome_saved" | "outreach_attributed",
): Promise<never> {
  const returnTo = workflowReturnPath(formData.get("returnTo"));
  let errorMessage: string | null = null;
  try {
    await execute(formData);
  } catch (error) {
    errorMessage = actionErrorMessage(error);
  }
  if (errorMessage) {
    redirect(appendWorkflowResult(returnTo, { error: errorMessage }));
  }
  redirect(appendWorkflowResult(returnTo, { [successKey]: "1" }));
}

export async function recordTrajectoryFeedbackAction(
  formData: FormData,
): Promise<never> {
  await requireServerActionAuth(formData.get("returnTo") ?? "/recommendations");
  return authenticatedAction(
    formData,
    (data) => executeTrajectoryFeedbackAction(data, dependencies()),
    "decision_saved",
  );
}

export async function recordTrajectoryOutcomeAction(
  formData: FormData,
): Promise<never> {
  await requireServerActionAuth(formData.get("returnTo") ?? "/recommendations");
  return authenticatedAction(
    formData,
    (data) => executeTrajectoryOutcomeAction(data, dependencies()),
    "outcome_saved",
  );
}

export async function attributeTrajectoryOutreachAction(
  formData: FormData,
): Promise<never> {
  await requireServerActionAuth(formData.get("returnTo") ?? "/recommendations");
  return authenticatedAction(
    formData,
    (data) => executeTrajectoryOutreachAttributionAction(data, dependencies()),
    "outreach_attributed",
  );
}
