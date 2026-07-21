"use server";

import { revalidatePath } from "next/cache";
import { requireServerActionAuth } from "@/lib/auth";
import {
  attributeTrajectoryOutreach,
  recordTrajectoryFeedback,
  recordTrajectoryOutcome,
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

export async function recordTrajectoryFeedbackAction(
  formData: FormData,
): Promise<void> {
  await requireServerActionAuth("/recommendations");
  return executeTrajectoryFeedbackAction(formData, dependencies());
}

export async function recordTrajectoryOutcomeAction(
  formData: FormData,
): Promise<void> {
  await requireServerActionAuth("/recommendations");
  return executeTrajectoryOutcomeAction(formData, dependencies());
}

export async function attributeTrajectoryOutreachAction(
  formData: FormData,
): Promise<void> {
  await requireServerActionAuth("/recommendations");
  return executeTrajectoryOutreachAttributionAction(formData, dependencies());
}
