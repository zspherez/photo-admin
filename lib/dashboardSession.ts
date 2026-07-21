import { createHash } from "node:crypto";
import type { AuthConfiguration } from "@/lib/auth";

const OWNER_CONTEXT = "photo-admin/dashboard-snapshot-owner/v1";
const PERSISTENCE_CONTEXT = "photo-admin/dashboard-persistence-scope/v1";

function sessionIdentity(
  cookieValue: string | undefined,
  configuration: AuthConfiguration
): string {
  return configuration.mode === "open"
    ? "open-development-mode"
    : configuration.mode === "protected" && cookieValue
      ? cookieValue
      : "unauthenticated";
}

function scopedHash(context: string, identity: string): string {
  return createHash("sha256")
    .update(`${context}\u0000${identity}`)
    .digest("hex");
}

export function dashboardSessionIdentity(
  cookieValue: string | undefined,
  configuration: AuthConfiguration
): { ownerKey: string; persistenceScope: string } {
  const identity = sessionIdentity(cookieValue, configuration);
  return {
    ownerKey: scopedHash(OWNER_CONTEXT, identity),
    persistenceScope: scopedHash(PERSISTENCE_CONTEXT, identity),
  };
}
