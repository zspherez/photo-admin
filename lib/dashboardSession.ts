import { createHash } from "node:crypto";
import type { AuthConfiguration } from "@/lib/auth";

const OWNER_CONTEXT = "photo-admin/dashboard-snapshot-owner/v1";

export function dashboardOwnerKey(
  cookieValue: string | undefined,
  configuration: AuthConfiguration
): string {
  const identity =
    configuration.mode === "open"
      ? "open-development-mode"
      : configuration.mode === "protected" && cookieValue
        ? cookieValue
        : "unauthenticated";
  return createHash("sha256")
    .update(`${OWNER_CONTEXT}\u0000${identity}`)
    .digest("hex");
}
