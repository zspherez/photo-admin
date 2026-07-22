import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import {
  getTrajectoryOperationalMetrics,
  type OperationalCount,
  type TrajectoryOperationalMetrics,
} from "@/lib/trajectoryMetrics";
import { TRAJECTORY_ARMS } from "@/lib/trajectoryContract";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Trajectory metrics" };

const number = new Intl.NumberFormat("en-US");

function timestamp(value: string | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function bytes(value: number): string {
  if (value < 1024) return `${number.format(value)} B`;
  return `${number.format(Math.round(value / 1024))} KiB`;
}

function operationalCount(value: OperationalCount): string {
  return value.value === null
    ? `Unavailable — ${value.unavailableReason}`
    : number.format(value.value);
}

function MetricList({
  rows,
}: {
  rows: Array<{ label: string; value: string | number }>;
}) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-zinc-500 dark:text-zinc-400">{row.label}</dt>
          <dd className="mt-0.5 font-medium">
            {typeof row.value === "number" ? number.format(row.value) : row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ArmTable({
  columns,
}: {
  columns: Array<{
    label: string;
    value: (arm: (typeof TRAJECTORY_ARMS)[number]) => string | number;
  }>;
}) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="min-w-full text-left text-xs">
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="px-2 py-2 font-medium">Arm</th>
            {columns.map((column) => (
              <th key={column.label} className="px-2 py-2 font-medium">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TRAJECTORY_ARMS.map((arm) => (
            <tr key={arm} className="border-t border-zinc-200 dark:border-zinc-800">
              <th className="px-2 py-2 font-medium">{arm}</th>
              {columns.map((column) => (
                <td key={column.label} className="px-2 py-2">
                  {column.value(arm)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricCard({
  title,
  scope,
  available = true,
  children,
}: {
  title: string;
  scope: string;
  available?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {scope}
            </p>
          </div>
          <Badge tone={available ? "success" : "warning"}>
            {available ? "Available" : "Unavailable"}
          </Badge>
        </div>
        {children}
      </CardBody>
    </Card>
  );
}

function RunMetrics({
  metrics,
}: {
  metrics: TrajectoryOperationalMetrics;
}) {
  const run = metrics.run;
  return (
    <>
      <MetricCard
        title="Run freshness"
        scope={metrics.scope.run}
        available={run !== null}
      >
        {run ? (
          <MetricList
            rows={[
              { label: "Availability", value: run.availability.replaceAll("_", " ") },
              { label: "Database status", value: run.status },
              { label: "Generated", value: timestamp(run.generatedAt) },
              { label: "Valid until", value: timestamp(run.validUntil) },
            ]}
          />
        ) : (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            No imported trajectory run exists.
          </p>
        )}
      </MetricCard>

      <MetricCard
        title="Import"
        scope={metrics.scope.run}
        available={metrics.import.available}
      >
        {run ? (
          <>
            <MetricList
              rows={[
                { label: "Imported", value: timestamp(run.importedAt) },
                { label: "Activated", value: timestamp(run.activatedAt) },
                { label: "Artifact size", value: bytes(run.artifactByteLength) },
                {
                  label: "Persisted artist rows",
                  value: metrics.import.persistedArtistRows,
                },
                {
                  label: "Persisted recommendation rows",
                  value: metrics.import.persistedRecommendationRows,
                },
                {
                  label: "Persisted suggested rows",
                  value: metrics.import.persistedSuggestedRows,
                },
              ]}
            />
            <p className="mt-3 break-all text-xs text-zinc-500">
              Producer run: {run.producerRunId}
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            Import counts require a selected run.
          </p>
        )}
      </MetricCard>

      <MetricCard
        title="Mapping and import issues"
        scope={metrics.scope.run}
        available={metrics.import.available}
      >
        {metrics.import.available ? (
          <MetricList
            rows={[
              {
                label: "Source artist rows",
                value: operationalCount(metrics.mapping.sourceArtistRows),
              },
              {
                label: "Mapped artist rows",
                value: operationalCount(metrics.mapping.mappedArtistRows),
              },
              {
                label: "Source recommendations",
                value: operationalCount(
                  metrics.mapping.sourceRecommendationRows,
                ),
              },
              {
                label: "Mapped recommendations",
                value: operationalCount(
                  metrics.mapping.mappedRecommendationRows,
                ),
              },
              {
                label: "Source suggested",
                value: operationalCount(metrics.mapping.sourceSuggestedRows),
              },
              {
                label: "Mapped suggested",
                value: operationalCount(metrics.mapping.mappedSuggestedRows),
              },
              {
                label: "Source non-suggested",
                value: operationalCount(
                  metrics.mapping.sourceNonSuggestedRows,
                ),
              },
              {
                label: "Mapped non-suggested",
                value: operationalCount(
                  metrics.mapping.mappedNonSuggestedRows,
                ),
              },
              {
                label: "All unresolved rows",
                value: metrics.mapping.unresolvedRows,
              },
              {
                label: "Unresolved suggested",
                value: operationalCount(
                  metrics.mapping.unresolvedSuggestedRows,
                ),
              },
              {
                label: "Unresolved non-suggested",
                value: operationalCount(
                  metrics.mapping.unresolvedNonSuggestedRows,
                ),
              },
              { label: "All issue records", value: metrics.issues.total },
              { label: "Show not found", value: metrics.issues.showNotFound },
              { label: "Artist not found", value: metrics.issues.artistNotFound },
              {
                label: "Membership missing",
                value: metrics.issues.membershipMissing,
              },
            ]}
          />
        ) : (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            Mapping and issue counts require a selected run.
          </p>
        )}
      </MetricCard>

      <MetricCard
        title="Contact readiness"
        scope="Active, mapped suggested recommendations in the selected run"
        available={metrics.contactReadiness.available}
      >
        {metrics.contactReadiness.available ? (
          <>
            <MetricList
              rows={[
                { label: "Recommendations checked", value: metrics.contactReadiness.scopeRows },
                { label: "Email ready now", value: metrics.contactReadiness.readyEmail },
                { label: "Email currently blocked", value: metrics.contactReadiness.emailBlocked },
                { label: "Direct channel available", value: metrics.contactReadiness.directOutreach },
                { label: "Needs contact channel", value: metrics.contactReadiness.needsContact },
              ]}
            />
            <p className="mt-3 text-xs text-zinc-500">
              Aggregated from current sendability and channel presence; no contact
              identity or recipient value is displayed.
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            Contact readiness requires a selected run.
          </p>
        )}
      </MetricCard>
    </>
  );
}

export default async function MetricsPage() {
  const metrics = await getTrajectoryOperationalMetrics();
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          Trajectory operational metrics
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          Authenticated, aggregate operational counts only. These observations
          are not probabilities and do not establish that a recommendation
          caused an engagement, access result, or outcome. No contact PII is
          shown.
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Snapshot generated {timestamp(metrics.generatedAt)}.
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <RunMetrics metrics={metrics} />

        <MetricCard title="Decisions" scope={metrics.scope.history}>
          <MetricList
            rows={[
              { label: "Current decision records", value: metrics.decisions.records },
              { label: "Selected", value: metrics.decisions.selected },
              { label: "Declined", value: metrics.decisions.declined },
              { label: "Saved", value: metrics.decisions.saved },
              { label: "Dismissed", value: metrics.decisions.dismissed },
              { label: "Manual override", value: metrics.decisions.manualOverride },
              { label: "Latest decision", value: timestamp(metrics.decisions.latestAt) },
            ]}
          />
          <ArmTable
            columns={[
              {
                label: "Records",
                value: (arm) => metrics.decisions.byArm[arm].records,
              },
              {
                label: "Selected",
                value: (arm) => metrics.decisions.byArm[arm].selected,
              },
              {
                label: "Declined",
                value: (arm) => metrics.decisions.byArm[arm].declined,
              },
              {
                label: "Saved",
                value: (arm) => metrics.decisions.byArm[arm].saved,
              },
              {
                label: "Dismissed",
                value: (arm) => metrics.decisions.byArm[arm].dismissed,
              },
              {
                label: "Override",
                value: (arm) => metrics.decisions.byArm[arm].manualOverride,
              },
            ]}
          />
        </MetricCard>

        <MetricCard title="Observed engagement" scope={metrics.scope.history}>
          <MetricList
            rows={[
              { label: "Attributed outreach", value: metrics.engagement.attributedOutreach },
              { label: "Sent", value: metrics.engagement.sent },
              { label: "Provider-reported delivered", value: metrics.engagement.delivered },
              { label: "Provider-reported opened", value: metrics.engagement.opened },
              { label: "Provider-reported clicked", value: metrics.engagement.clicked },
              { label: "Bounced", value: metrics.engagement.bounced },
              { label: "Complained", value: metrics.engagement.complained },
            ]}
          />
          <ArmTable
            columns={[
              {
                label: "Outreach",
                value: (arm) =>
                  metrics.engagement.byArm[arm].attributedOutreach,
              },
              {
                label: "Sent",
                value: (arm) => metrics.engagement.byArm[arm].sent,
              },
              {
                label: "Delivered",
                value: (arm) => metrics.engagement.byArm[arm].delivered,
              },
              {
                label: "Opened",
                value: (arm) => metrics.engagement.byArm[arm].opened,
              },
              {
                label: "Clicked",
                value: (arm) => metrics.engagement.byArm[arm].clicked,
              },
              {
                label: "Bounced",
                value: (arm) => metrics.engagement.byArm[arm].bounced,
              },
              {
                label: "Complained",
                value: (arm) => metrics.engagement.byArm[arm].complained,
              },
            ]}
          />
        </MetricCard>

        <MetricCard title="Access" scope={metrics.scope.history}>
          <MetricList
            rows={[
              { label: "Current outcome records", value: metrics.access.records },
              { label: "Access not recorded", value: metrics.access.notRecorded },
              { label: "No access", value: metrics.access.none },
              { label: "Guest list", value: metrics.access.guestlist },
              { label: "Photo pass", value: metrics.access.photoPass },
              { label: "Other access", value: metrics.access.other },
            ]}
          />
          <ArmTable
            columns={[
              {
                label: "Records",
                value: (arm) => metrics.access.byArm[arm].records,
              },
              {
                label: "Not recorded",
                value: (arm) => metrics.access.byArm[arm].notRecorded,
              },
              {
                label: "None",
                value: (arm) => metrics.access.byArm[arm].none,
              },
              {
                label: "Guest list",
                value: (arm) => metrics.access.byArm[arm].guestlist,
              },
              {
                label: "Photo pass",
                value: (arm) => metrics.access.byArm[arm].photoPass,
              },
              {
                label: "Other",
                value: (arm) => metrics.access.byArm[arm].other,
              },
            ]}
          />
        </MetricCard>

        <MetricCard title="Outcomes" scope={metrics.scope.history}>
          <MetricList
            rows={[
              { label: "Current outcome records", value: metrics.outcomes.records },
              { label: "Attended", value: metrics.outcomes.attended },
              { label: "Not attended", value: metrics.outcomes.notAttended },
              {
                label: "Attendance not recorded",
                value: metrics.outcomes.attendanceNotRecorded,
              },
              {
                label: "Keeper count recorded",
                value: metrics.outcomes.keeperCountRecorded,
              },
              { label: "Keeper total", value: metrics.outcomes.keeperTotal },
              {
                label: "Relationship value 0 / 1 / 2",
                value: metrics.outcomes.relationshipValue.join(" / "),
              },
              {
                label: "Publication value 0 / 1 / 2",
                value: metrics.outcomes.publicationValue.join(" / "),
              },
              {
                label: "Shootability good / ok / poor",
                value: `${metrics.outcomes.shootability.good} / ${metrics.outcomes.shootability.ok} / ${metrics.outcomes.shootability.poor}`,
              },
              {
                label: "Venue access high / medium / low",
                value: `${metrics.outcomes.venueAccessibility.high} / ${metrics.outcomes.venueAccessibility.medium} / ${metrics.outcomes.venueAccessibility.low}`,
              },
              { label: "Latest outcome", value: timestamp(metrics.outcomes.latestAt) },
            ]}
          />
          <ArmTable
            columns={[
              {
                label: "Records",
                value: (arm) => metrics.outcomes.byArm[arm].records,
              },
              {
                label: "Attended",
                value: (arm) => metrics.outcomes.byArm[arm].attended,
              },
              {
                label: "Not attended",
                value: (arm) => metrics.outcomes.byArm[arm].notAttended,
              },
              {
                label: "Keepers",
                value: (arm) => metrics.outcomes.byArm[arm].keeperTotal,
              },
            ]}
          />
        </MetricCard>

        <MetricCard
          title="Export lag"
          scope="Trajectory engagement JSONL export"
          available={metrics.exportLag.available}
        >
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
            {metrics.exportLag.reason}
          </p>
          <MetricList
            rows={[
              {
                label: "Currently exportable outreach rows",
                value: metrics.exportLag.exportableOutreachRows,
              },
            ]}
          />
        </MetricCard>

        <MetricCard
          title="Same-night alternatives"
          scope="Active, mapped suggested recommendations in the selected run"
          available={metrics.sameNight.available}
        >
          {metrics.sameNight.available ? (
            <MetricList
              rows={[
                {
                  label: "Nights with multiple shows",
                  value: metrics.sameNight.nightsWithAlternatives,
                },
                { label: "Distinct shows on those nights", value: metrics.sameNight.distinctShows },
                {
                  label: "Recommendation rows on those nights",
                  value: metrics.sameNight.recommendationRows,
                },
              ]}
            />
          ) : (
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
              Same-night counts require a selected run.
            </p>
          )}
          <div className="mt-4 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            <span className="font-medium">Primary/backup comparison unavailable:</span>{" "}
            {metrics.sameNight.comparisonReason}
          </div>
        </MetricCard>
      </div>
    </main>
  );
}
