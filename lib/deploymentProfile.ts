/**
 * Deployment profile selection for `scripts/deployment-readiness.ts`.
 *
 * A "profile" only changes which local checks `npm run deployment:readiness`
 * runs. It is never read by the running app or by any GitHub Actions
 * workflow, so selecting a profile here cannot enable, disable, or bypass
 * anything — the hardened release/recovery workflow in
 * `.github/workflows/release-production.yml` is authorized independently by
 * its own trusted-dispatch checks (see `HARDENED_RELEASE_REPOSITORY` there),
 * and Vercel's native Git auto-deploy is controlled solely by
 * `git.deploymentEnabled.main` in `vercel.json`. See docs/deployment.md.
 */

export type DeploymentProfile = "basic" | "hardened";

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = [
  "basic",
  "hardened",
];

/**
 * "basic" (native Vercel Git deploys) is the default: it is the simplest
 * usable path for a fresh fork and requires no GitHub Actions configuration.
 */
export const DEFAULT_DEPLOYMENT_PROFILE: DeploymentProfile = "basic";

export interface DeploymentProfileEnvironment {
  readonly DEPLOYMENT_PROFILE?: string;
  readonly [key: string]: string | undefined;
}

function isDeploymentProfile(value: string): value is DeploymentProfile {
  return (DEPLOYMENT_PROFILES as readonly string[]).includes(value);
}

/**
 * Resolves the deployment profile deterministically: an explicit `--profile`
 * CLI value wins, then `DEPLOYMENT_PROFILE`, then the documented default.
 * Returns `null` when a value is explicitly given but unrecognized, so
 * callers fail closed instead of silently guessing a profile.
 */
export function resolveDeploymentProfile(
  cliValue: string | undefined,
  env: DeploymentProfileEnvironment = process.env,
): DeploymentProfile | null {
  const raw = (cliValue ?? env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_DEPLOYMENT_PROFILE;
  return isDeploymentProfile(raw) ? raw : null;
}
