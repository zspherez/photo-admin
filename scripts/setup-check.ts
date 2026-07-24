import "dotenv/config";
import { runSetupDiagnostics } from "@/lib/setupDiagnostics";

function statusMarker(status: string): string {
  return status === "ok" ? "OK" : status.toUpperCase();
}

function main(): void {
  const report = runSetupDiagnostics(process.env);

  console.log("Required core configuration");
  console.log("----------------------------");
  for (const item of report.required) {
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

  console.log(
    `\n${
      report.ok
        ? "Required setup looks complete."
        : "Required setup is incomplete — fix the FAILED/INVALID/MISSING items above."
    }`,
  );

  process.exit(report.ok ? 0 : 1);
}

main();
