import { refresh, revalidatePath } from "next/cache";
import { workflowReturnPath } from "@/lib/dashboardReturnUrl";

const WORKFLOW_ORIGIN = "https://workflow.local";

function revalidationPath(value: string): string {
  const url = new URL(value, WORKFLOW_ORIGIN);
  if (url.origin !== WORKFLOW_ORIGIN || !url.pathname.startsWith("/")) {
    throw new Error("Revalidation destination must be an internal path");
  }
  return url.pathname;
}

export function workflowRevalidationPaths(
  returnTo: unknown,
  relatedPaths: readonly string[] = [],
): string[] {
  return Array.from(
    new Set([
      "/dashboard",
      revalidationPath(workflowReturnPath(returnTo)),
      ...relatedPaths.map(revalidationPath),
    ]),
  );
}

export function refreshWorkflowViews(
  returnTo: unknown,
  relatedPaths: readonly string[] = [],
): void {
  refresh();
  for (const path of workflowRevalidationPaths(returnTo, relatedPaths)) {
    revalidatePath(path);
  }
}
