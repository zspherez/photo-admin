# photo-admin

Private operations software for concert and festival photography outreach.

This Next.js app combines shows, recommendations, management-contact research,
audits, templates, and email delivery for one photographer. Nothing sends
outreach automatically. Its network-only PWA never caches private pages or
mutations; see [docs/mobile-pwa.md](docs/mobile-pwa.md).

## Main pages

| Page | Purpose |
|---|---|
| **Shows** (`/dashboard`) | Review shows; customize, queue, or send outreach. |
| **Recommendations** (`/recommendations`) | Review trajectory, momentum, exploration, and portfolio suggestions. |
| **Research** (`/research`) | Review manager candidates, skips, exhausted searches, and direct-outreach proposals. |
| **Audit** (`/contact-audit`) | Review an artist's roster, evidence, and proposed changes. |
| **Emails** (`/emails`, `/outreach`) | Inspect outreach and delivery history. |
| **Contacts** (`/contacts`) | Browse artist contacts. |
| **Festivals** (`/festivals`) | Manage lineups and outreach. |
| **All shows / Sync** (`/shows`) | Inspect synced shows and run a manual sync. |
| **Settings** (`/settings`) | Configure identity, integrations, templates, agents, and queues. |

## Contact research and audit

Research finds public, evidence-backed management contacts for artists without
an active email. Audits re-check active contacts against public sources.

Audit review is artist-level. The operator can:

- **Append** a proposal while keeping the current roster.
- **Replace selected contacts** by adding the proposal and quarantining only
  those selected.
- **Deactivate selected stale contacts** without a replacement.
- **Reject** the proposal without changing the roster.

Replacement does not rewrite identities. Quarantined contacts, history, and
decisions remain available. Shared addresses are valid when new for the artist.

Contact research and audit queues poll every 10 minutes and no-op cheaply when
idle. Research discovery runs hourly. A durable, idempotent full audit is
enqueued monthly; a mid-month rolling audit covers artists with active shows
30–60 days out. Both wait behind any active audit.

Both agents are pinned to `gpt-5.6-sol` with maximum reasoning effort. They use
public professional management sources, never bypass access controls, and
exclude booking, publicity, label, promoter, venue, and press contacts.

Production mutations use workflow-scoped GitHub Actions OIDC. Static agent
tokens are for explicit local or development use only.

## View-only access

Set a distinct `READ_ONLY_PASSWORD` for a second login. Users may navigate and
filter, but cannot save, sync, queue, schedule, send, or connect integrations.
This no-mutation boundary is enforced server-side through the signed session.

Template previews are redacted with Lorem ipsum so stored outreach copy is not
exposed. Contact the repository owner for a test view-only login.

## Local setup

Requires Node.js 22.x, Postgres, and credentials only for integrations in use.

```bash
git clone <this repo>
cd photo-admin
cp .env.example .env
# Set DATABASE_URL and DIRECT_URL.
npm install
npm run db:setup
npm run setup:check
npm run dev
```

Open <http://127.0.0.1:3000>.

Protected mode requires `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`. Local-only
open mode uses a blank password plus `ALLOW_INSECURE_OPEN_MODE=true`.

`npm run setup:check` separates required core configuration (database,
`APP_BASE_URL`, authentication) from optional integrations, exits nonzero only
when required setup is missing or invalid, and never prints secret values.

## Forking

Branding, repository identity, market, time zone, outreach dispatch time,
EDMTrain location scope, and the GitHub Actions workflows trusted for contact
research/audit OIDC all live in one typed module: [`lib/appConfig.ts`](lib/appConfig.ts).
Edit its constants directly to rebrand a fork; every default there reproduces
this deployment's current behavior exactly. Repository identity and the two
workflow trust refs can also be overridden per-deployment via
`REPOSITORY_SLUG`, `CONTACT_RESEARCH_WORKFLOW_REF`, and
`CONTACT_AUDIT_WORKFLOW_REF` — malformed overrides are rejected so trust fails
closed rather than silently defaulting to something unexpected.

## Essential environment groups

`.env.example` and [`docs/environment.md`](docs/environment.md) are generated
from the single schema in [`lib/envSchema.ts`](lib/envSchema.ts). Run
`npm run env:generate` after editing the schema, or `npm run env:check` to
verify neither generated file has drifted.

| Group | Essentials |
|---|---|
| Core | Database URLs, `APP_BASE_URL`, admin password/session secret, optional `READ_ONLY_PASSWORD` |
| Fork identity | Optional `REPOSITORY_SLUG` and workflow trust ref overrides — see [Forking](#forking) |
| Email | Resend API key, sender, webhook secret, optional test override |
| Shows/listening | EDMTrain key, Spotify client credentials, stats.fm token |
| Google Sheets export | Optional Google credentials and `GOOGLE_CONTACT_EXPORT_SPREADSHEET_ID` |
| Automation | `CRON_SECRET`; local-only contact agent tokens |
| Trajectory | Ingest auth mode, GitHub repository/workflow ref, receipt secret, fallback HMAC secret |

Postgres is the only contact source of truth. Optional Google Sheets exports
create new immutable snapshot tabs and are never imported back into the app.
The service account needs Editor access only to the destination spreadsheet.

## Production release safety

The release workflow accepts an exact full SHA reachable from `main` plus
`confirmation=RELEASE`. It validates code, runtime, and database bindings,
runs migrations, promotes, and verifies compatibility.

Production pauses only after the revision is proven. Recovery is main-only and
limited to proven targets. Use durable project-scoped Vercel CI tokens.

Configure **`production-recovery`** separately:

- Do **not** configure required reviewers; recovery must not wait for another
  approval after a failed reviewed release.
- Choose **Selected branches and tags**, allow only the branch rule `main`,
  and add no tag rules.
- Set `RECOVERY_ENVIRONMENT_GUARD=production-recovery-main-only-v1`.
- Keep dedicated recovery Vercel values there. Delete every repository-level
  duplicate recovery credential.

GitHub API permissions cannot enforce an environment's
deployment branch policy, so verify it manually in repository settings.

To release, push the revision to `main`, copy its exact full SHA, then dispatch
**Release production** with `confirmation=RELEASE`.

## Common commands

```bash
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run setup:check
npm run env:check
npm run db:setup
npm run db:verify-targets
npm run db:verify-release-compatibility
npm run contact-research:agent
npm run contact-audit:agent
npm run trajectory:production:verify
```

`npm test` uses unreachable test database URLs and clears production
credentials. `scripts/smoke.ts` writes data and refuses production targets.
