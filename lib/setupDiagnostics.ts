/**
 * Pure, deterministic setup diagnostics: separates required core
 * configuration from optional integrations without any network/DB access
 * and without ever printing secret values. `scripts/setup-check.ts` is the
 * thin CLI wrapper (`npm run setup:check`).
 */
import { getAuthConfiguration } from "@/lib/auth";
import {
  resolveContactAuditTrustConfig,
  resolveContactResearchTrustConfig,
  resolveRepositoryIdentity,
} from "@/lib/appConfig";
import {
  ENV_VAR_GROUPS,
  ENV_VAR_GROUP_ORDER,
  envVarsByGroup,
  type EnvVarGroup,
} from "@/lib/envSchema";

export type SetupCheckStatus = "ok" | "missing" | "invalid";

export interface SetupCheckItem {
  readonly key: string;
  readonly label: string;
  readonly status: SetupCheckStatus;
  /** Human-readable and safe: never contains a secret value. */
  readonly detail: string;
}

export interface OptionalIntegrationItem {
  readonly key: string;
  readonly set: boolean;
}

export interface OptionalIntegrationStatus {
  readonly group: EnvVarGroup;
  readonly heading: string;
  readonly configured: boolean;
  readonly items: readonly OptionalIntegrationItem[];
}

export interface SetupDiagnosticsReport {
  readonly ok: boolean;
  readonly required: readonly SetupCheckItem[];
  readonly optional: readonly OptionalIntegrationStatus[];
}

const CORE_ENV_GROUPS = new Set<EnvVarGroup>(["database", "app"]);

/**
 * Deliberately looser than `NodeJS.ProcessEnv` (which Next.js augments with a
 * required `NODE_ENV`) so tests can pass minimal, ad-hoc fixtures while
 * `process.env` itself remains a valid argument at every call site.
 */
export type SetupCheckEnvironment = Readonly<Record<string, string | undefined>>;

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function checkPostgresUrl(
  key: string,
  label: string,
  value: string | undefined,
): SetupCheckItem {
  if (isBlank(value)) {
    return { key, label, status: "missing", detail: `${key} is not set` };
  }
  try {
    const parsed = new URL(value!.trim());
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("invalid");
    }
    return { key, label, status: "ok", detail: "set" };
  } catch {
    return {
      key,
      label,
      status: "invalid",
      detail: `${key} must be a valid postgres:// or postgresql:// URL`,
    };
  }
}

function checkAbsoluteUrl(
  key: string,
  label: string,
  value: string | undefined,
): SetupCheckItem {
  if (isBlank(value)) {
    return { key, label, status: "missing", detail: `${key} is not set` };
  }
  try {
    const parsed = new URL(value!.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid");
    }
    return { key, label, status: "ok", detail: "set" };
  } catch {
    return {
      key,
      label,
      status: "invalid",
      detail: `${key} must be an absolute http(s) URL`,
    };
  }
}

/**
 * Runs every required-core and optional-integration check against `env`
 * (defaults to `process.env`). Pure and side-effect free: no network calls,
 * no database access, and no secret values are ever included in the report.
 */
export function runSetupDiagnostics(
  env: SetupCheckEnvironment = process.env,
): SetupDiagnosticsReport {
  const required: SetupCheckItem[] = [
    checkPostgresUrl("DATABASE_URL", "Pooled Postgres connection", env.DATABASE_URL),
    checkPostgresUrl("DIRECT_URL", "Direct Postgres connection", env.DIRECT_URL),
    checkAbsoluteUrl("APP_BASE_URL", "Public base URL", env.APP_BASE_URL),
  ];

  const auth = getAuthConfiguration(
    env.ADMIN_PASSWORD,
    env.ADMIN_SESSION_SECRET,
    { nodeEnv: env.NODE_ENV, allowInsecureOpenMode: env.ALLOW_INSECURE_OPEN_MODE },
    env.READ_ONLY_PASSWORD,
  );
  required.push({
    key: "AUTH",
    label:
      "Authentication (ADMIN_PASSWORD + ADMIN_SESSION_SECRET, or local-only open mode)",
    status: auth.mode === "misconfigured" ? "invalid" : "ok",
    detail: auth.mode === "misconfigured" ? auth.error : `mode=${auth.mode}`,
  });

  // Fork-identity overrides are optional, but if explicitly set they must be
  // valid: an invalid override silently disables OIDC trust (fail closed),
  // so surface it as a required-configuration failure rather than a warning.
  if (!isBlank(env.REPOSITORY_SLUG)) {
    const repository = resolveRepositoryIdentity(env);
    required.push({
      key: "REPOSITORY_SLUG",
      label: "Repository identity override",
      status: repository ? "ok" : "invalid",
      detail: repository
        ? `resolves to ${repository.slug}`
        : 'REPOSITORY_SLUG must look like "owner/name"',
    });
  }
  if (!isBlank(env.CONTACT_RESEARCH_WORKFLOW_REF)) {
    const trust = resolveContactResearchTrustConfig(env);
    required.push({
      key: "CONTACT_RESEARCH_WORKFLOW_REF",
      label: "Contact research OIDC trust override",
      status: trust ? "ok" : "invalid",
      detail: trust
        ? "resolves to a valid trusted workflow ref"
        : "must reference a .yml/.yaml workflow under <repository>/.github/workflows/ on refs/heads/main",
    });
  }
  if (!isBlank(env.CONTACT_AUDIT_WORKFLOW_REF)) {
    const trust = resolveContactAuditTrustConfig(env);
    required.push({
      key: "CONTACT_AUDIT_WORKFLOW_REF",
      label: "Contact audit OIDC trust override",
      status: trust ? "ok" : "invalid",
      detail: trust
        ? "resolves to a valid trusted workflow ref"
        : "must reference a .yml/.yaml workflow under <repository>/.github/workflows/ on refs/heads/main",
    });
  }

  const optional: OptionalIntegrationStatus[] = [];
  for (const group of ENV_VAR_GROUP_ORDER) {
    if (CORE_ENV_GROUPS.has(group) || group === "fork-identity") continue;
    const items = envVarsByGroup(group).map((entry) => ({
      key: entry.key,
      set: !isBlank(env[entry.key]),
    }));
    optional.push({
      group,
      heading: ENV_VAR_GROUPS[group].heading,
      configured: items.some((item) => item.set),
      items,
    });
  }

  return {
    ok: required.every((item) => item.status === "ok"),
    required,
    optional,
  };
}
