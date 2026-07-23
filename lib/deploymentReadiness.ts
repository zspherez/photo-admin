/**
 * Pure, deterministic deployment readiness diagnostics: builds on
 * `runSetupDiagnostics` and adds profile-specific requirements without any
 * network/DB/Vercel/GitHub API access and without ever printing secret
 * values. `scripts/deployment-readiness.ts` is the thin CLI wrapper
 * (`npm run deployment:readiness`).
 *
 * This module only inspects local environment variables. It never claims to
 * verify Vercel project settings or GitHub repository/environment
 * configuration (deployment branch policies, secrets, variables) — those
 * cannot be read from local `process.env`, so they are surfaced only as
 * `warnings` the operator must confirm manually. See docs/deployment.md.
 */
import {
  runSetupDiagnostics,
  type SetupCheckEnvironment,
  type SetupCheckItem,
  type OptionalIntegrationStatus,
} from "@/lib/setupDiagnostics";
import type { DeploymentProfile } from "@/lib/deploymentProfile";

export interface DeploymentReadinessReport {
  readonly profile: DeploymentProfile;
  /** True only when every required-core and profile-required item is "ok". */
  readonly ok: boolean;
  readonly core: readonly SetupCheckItem[];
  readonly profileRequired: readonly SetupCheckItem[];
  readonly optional: readonly OptionalIntegrationStatus[];
  /**
   * Reminders about configuration this script cannot see or verify (Vercel
   * project settings, GitHub repository/environment secrets and variables).
   * Never affects `ok` or the process exit code.
   */
  readonly warnings: readonly string[];
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

const BASIC_PROFILE_WARNING =
  'Basic profile also relies on Vercel project settings this script cannot see or verify: ' +
  'Git integration enabled for your production branch (vercel.json "git.deploymentEnabled.main" ' +
  'must be true, or the "git" block removed) and a Build Command that runs ' +
  '`npm run db:migrate:deploy` before `npm run build` so schema migrations are applied. ' +
  "See docs/deployment.md.";

const HARDENED_PROFILE_WARNING =
  "Hardened profile also requires GitHub-side configuration this script cannot see or verify: " +
  'the "production" and "production-recovery" GitHub Environments with their Vercel secrets, ' +
  "a deployment branch policy restricting both to main, RECOVERY_ENVIRONMENT_GUARD, and " +
  "(for forks) the HARDENED_RELEASE_REPOSITORY repository variable set to the fork's own " +
  "owner/name. See docs/deployment.md.";

function cronSecretWarning(): string {
  return (
    "CRON_SECRET is not set. Vercel Cron requests to /api/cron/* will be rejected (401) until " +
    "it is set here and in the Vercel project's environment variables. Required only if you use " +
    "the scheduled crons shipped in vercel.json."
  );
}

/**
 * Runs required-core checks (shared by every profile) plus the checks that
 * are only meaningful for `profile`, against `env` (defaults to
 * `process.env`). Pure and side-effect free.
 */
export function runDeploymentReadiness(
  profile: DeploymentProfile,
  env: SetupCheckEnvironment = process.env,
): DeploymentReadinessReport {
  const core = runSetupDiagnostics(env);
  const profileRequired: SetupCheckItem[] = [];
  const warnings: string[] = [];
  const cronSecretSet = !isBlank(env.CRON_SECRET);

  if (profile === "hardened") {
    // The release workflow's runtime verification step
    // (app/api/release/runtime-verification/route.ts) authenticates with
    // CRON_SECRET; without it, a hardened release cannot pass verification.
    profileRequired.push({
      key: "CRON_SECRET",
      label: "Release runtime verification shared secret",
      status: cronSecretSet ? "ok" : "missing",
      detail: cronSecretSet
        ? "set"
        : "CRON_SECRET is required for the hardened release workflow's runtime verification step to authenticate.",
    });
    warnings.push(HARDENED_PROFILE_WARNING);
  } else {
    if (!cronSecretSet) warnings.push(cronSecretWarning());
    warnings.push(BASIC_PROFILE_WARNING);
  }

  return {
    profile,
    ok:
      core.ok && profileRequired.every((item) => item.status === "ok"),
    core: core.required,
    profileRequired,
    optional: core.optional,
    warnings,
  };
}
