import { dashboardResultHref } from "@/lib/dashboardReturnUrl";
import { TrajectoryActionError } from "@/lib/trajectoryActiveRun";
import { TrajectoryFeedbackError } from "@/lib/trajectoryFeedback";

const TRAJECTORY_FEEDBACK_ACTION_CODES = new Set([
  "recommendation_not_found",
  "recommendation_attribution_mismatch",
  "recommendation_not_actionable",
]);

export function trajectoryActionErrorMessage(error: unknown): string | null {
  if (error instanceof TrajectoryActionError) return error.message;
  if (
    error instanceof TrajectoryFeedbackError &&
    TRAJECTORY_FEEDBACK_ACTION_CODES.has(error.code)
  ) {
    return error.message;
  }
  return null;
}

export function trajectoryActionErrorHref(
  returnTo: unknown,
  error: unknown,
): string | null {
  const message = trajectoryActionErrorMessage(error);
  return message
    ? dashboardResultHref(returnTo, "error", message)
    : null;
}

export function trajectoryActionResultHref(
  returnTo: unknown,
  result: {
    ok: boolean;
    error?: string;
    trajectoryError?: boolean;
  },
): string | null {
  if (result.ok || !result.trajectoryError) return null;
  return dashboardResultHref(
    returnTo,
    "error",
    result.error ?? "Trajectory recommendation is no longer actionable",
  );
}

export type CapturedTrajectoryAction<T> =
  | { ok: true; value: T }
  | { ok: false; errorHref: string };

export async function captureTrajectoryAction<T>(
  returnTo: unknown,
  action: () => Promise<T>,
): Promise<CapturedTrajectoryAction<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const errorHref = trajectoryActionErrorHref(returnTo, error);
    if (!errorHref) throw error;
    return { ok: false, errorHref };
  }
}
