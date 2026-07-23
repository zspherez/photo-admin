import "dotenv/config";
import {
  DEPLOYMENT_PROFILES,
  resolveDeploymentProfile,
} from "@/lib/deploymentProfile";
import { runDeploymentReadiness } from "@/lib/deploymentReadiness";

interface CliArguments {
  readonly profile?: string;
  readonly json: boolean;
}

function parseArguments(argv: readonly string[]): CliArguments {
  let profile: string | undefined;
  let json = false;
  for (const argument of argv) {
    if (argument === "--json") {
      json = true;
    } else if (argument.startsWith("--profile=")) {
      profile = argument.slice("--profile=".length);
    } else if (argument === "--profile") {
      throw new Error(
        `--profile requires a value, e.g. --profile=${DEPLOYMENT_PROFILES[0]}`,
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { profile, json };
}

function statusMarker(status: string): string {
  return status === "ok" ? "OK" : status.toUpperCase();
}

function printHuman(
  report: ReturnType<typeof runDeploymentReadiness>,
): void {
  console.log(`Deployment profile: ${report.profile}`);
  console.log(
    "Offline, read-only check of local environment variables only. It cannot verify Vercel",
  );
  console.log(
    "project settings or GitHub repository/environment configuration — see the warnings below.",
  );

  console.log("\nRequired core configuration");
  console.log("----------------------------");
  for (const item of report.core) {
    console.log(`[${statusMarker(item.status)}] ${item.label} — ${item.detail}`);
  }

  console.log(`\nRequired for the "${report.profile}" profile`);
  console.log("-".repeat(24 + report.profile.length));
  if (report.profileRequired.length === 0) {
    console.log("(none beyond required core configuration)");
  }
  for (const item of report.profileRequired) {
    console.log(`[${statusMarker(item.status)}] ${item.label} — ${item.detail}`);
  }

  console.log("\nOptional integrations (never required, never fail the check)");
  console.log("---------------------------------------------------------------");
  for (const group of report.optional) {
    console.log(
      `- ${group.heading}: ${group.configured ? "configured" : "not configured"}`,
    );
    for (const item of group.items) {
      console.log(`    ${item.set ? "✓" : "·"} ${item.key}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("\nWarnings (cannot be verified from local environment)");
    console.log("-------------------------------------------------------");
    for (const warning of report.warnings) console.log(`! ${warning}`);
  }

  console.log(
    `\n${
      report.ok
        ? `Required setup for the "${report.profile}" profile looks complete.`
        : `Required setup for the "${report.profile}" profile is incomplete — fix the FAILED/INVALID/MISSING items above.`
    }`,
  );
}

function main(): void {
  const { profile: cliProfile, json } = parseArguments(process.argv.slice(2));
  const profile = resolveDeploymentProfile(cliProfile, process.env);
  if (!profile) {
    console.error(
      `Unknown deployment profile. Use --profile=<${DEPLOYMENT_PROFILES.join("|")}> or set DEPLOYMENT_PROFILE.`,
    );
    process.exit(1);
    return;
  }

  const report = runDeploymentReadiness(profile, process.env);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
