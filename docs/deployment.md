# Deployment

This app supports two deployment profiles on [Vercel](https://vercel.com). Pick
one — they are not combined, and switching later is just re-doing the setup
steps below for the other profile.

| | **Basic** (default, recommended for most forks) | **Hardened** (this deployment's production profile) |
|---|---|---|
| How production deploys | Vercel's native Git integration auto-deploys every push to your production branch | A dispatched GitHub Actions workflow builds, verifies, and promotes one exact commit SHA |
| Setup effort | Connect the repo to a Vercel project; set env vars | The above, plus two GitHub Environments, repository secrets, and a maintenance-window habit |
| Guarantees | Whatever Vercel's Git integration gives you (fast, standard, not exact-SHA audited) | Exact-SHA release, staged verification before cutover, independent recovery watchdog |
| Rollback | Vercel dashboard → previous deployment → **Instant Rollback** | Dedicated `production-recovery` GitHub Environment + independent watchdog job (see below) |

Both profiles run the exact same Next.js app, `vercel.json` crons, and Postgres
schema; only *how a commit reaches production* differs. Neither profile is a
workflow input or runtime flag — each is selected by real, external
configuration (a `vercel.json` field, and, for hardened, GitHub repository
configuration), so neither can be flipped by anyone dispatching a workflow.

Run `npm run deployment:readiness` locally at any time — see
[Checking readiness](#checking-readiness) below.

## Prerequisites (both profiles)

- Node.js 22.x and a Postgres database reachable from Vercel (pooled
  `DATABASE_URL` + direct `DIRECT_URL`; see [`docs/environment.md`](environment.md)).
- A [Vercel](https://vercel.com) account and project, and, for hardened, the
  Vercel CLI locally is optional (the workflow installs its own pinned copy).
- Every environment variable your fork actually uses. Run
  `npm run env:generate` after editing `lib/envSchema.ts`, and `npm run
  setup:check` (or `npm run deployment:readiness`) to confirm required core
  configuration before deploying either profile.
- Vercel Cron requires `CRON_SECRET` to be set identically in your Vercel
  project's environment variables and (for the automation workflows in
  `.github/workflows/`) as a matching repository secret.

## Basic profile: native Vercel Git deploys

1. In the Vercel dashboard, **Add New… → Project**, import this repository,
   and select your production branch (typically `main`).
2. In **Project Settings → Environment Variables**, set every variable your
   fork needs for the `production` (and, if used, `preview`) environment —
   see [`docs/environment.md`](environment.md). Never commit secret values;
   `.env.example` only documents names and safe placeholder defaults.
3. Edit `vercel.json` in your fork:
   ```json
   {
     "git": {
       "deploymentEnabled": {
         "main": true
       }
     }
   }
   ```
   (or delete the whole `"git"` block — Vercel's default is auto-deploy
   enabled). This repository ships that flag as `false` because *this*
   deployment uses the hardened profile below; flipping it to `true` is the
   one deterministic, explicit step that opts a fork into the basic profile.
4. Set your Vercel project's **Build Command** to run migrations before every
   build, since the basic profile has no separate release job to do it:
   ```
   npm run db:migrate:deploy && npm run build
   ```
   `db:migrate:deploy` runs `prisma migrate deploy`, which only applies
   already-committed, already-reviewed migrations and is safe to re-run.
5. Push to your production branch. Vercel builds and deploys automatically.
   `vercel.json`'s `crons` entries start running once the project is deployed
   and `CRON_SECRET` matches in both places.
6. **Rollback**: use Vercel's dashboard (**Deployments → ⋯ → Instant
   Rollback**) or redeploy an older commit. The basic profile does not verify
   an exact SHA before promoting traffic — if you need that guarantee, use the
   hardened profile instead.

Nothing above requires any file this repository doesn't already ship, and
nothing here touches `.github/workflows/release-production.yml` — that
workflow only ever runs when someone explicitly dispatches it, which requires
the repository configuration described next.

## Hardened profile: exact-SHA release + recovery

This is optional, additional rigor on top of the basic profile's mechanics —
opt in only if you want an audited, staged, exact-commit release process with
an independent recovery path. It is what this repository's own production
deployment uses.

### 1. Keep native Git deploys disabled

Leave `vercel.json`'s `git.deploymentEnabled.main` as `false` (the shipped
default). This is what makes `.github/workflows/release-production.yml` the
*only* path to production — if Vercel also auto-deployed pushes, an unreviewed
commit could reach production outside the audited release process.

### 2. Authorize the workflow for your repository

`release-production.yml` fails closed by default: every authorization check
compares `github.repository`/`github.workflow_ref` against
`HARDENED_RELEASE_REPOSITORY`, a workflow-level variable that itself defaults
to `vars.HARDENED_RELEASE_REPOSITORY || 'zspherez/photo-admin'`. That means:

- This repository's own production releases keep working unchanged with no
  extra configuration (the fallback already matches it).
- A fork of this repository **cannot** dispatch a working hardened release
  until it explicitly sets its own **repository variable**
  `HARDENED_RELEASE_REPOSITORY` (Settings → Secrets and variables → Actions →
  Variables) to its own `owner/name`. Until then, every trust check compares
  the fork's real `github.repository` against the upstream default and fails
  — there is no accidental or partial hardened mode.

### 3. Configure the `production` GitHub Environment

Add these **environment secrets** to a `production` GitHub Environment:

- `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` — a durable,
  project-scoped Vercel token plus the target project's identifiers.
- `DATABASE_URL`, `DIRECT_URL` — the same production Postgres connection
  strings configured in Vercel.
- `APP_BASE_URL` — the exact production HTTPS origin (no path/query), matching
  the Vercel project's own `APP_BASE_URL`.
- `CRON_SECRET` — must match the value configured in the Vercel project;
  the release job's runtime verification step
  (`app/api/release/runtime-verification/route.ts`) authenticates with it, so
  a release cannot pass verification without it.

Restrict the environment's deployment branch policy to **Selected branches and
tags**, allowing only the branch rule `main`, with required reviewers if you
want a manual approval gate before release (recovery, below, deliberately
skips this).

### 4. Configure the `production-recovery` GitHub Environment

Configure **`production-recovery`** separately, with its own dedicated Vercel
credentials (`RECOVERY_VERCEL_TOKEN`, `RECOVERY_VERCEL_ORG_ID`,
`RECOVERY_VERCEL_PROJECT_ID`) scoped to the *same* production Vercel project:

- Do **not** configure required reviewers; recovery must not wait for another
  approval after a failed reviewed release.
- Choose **Selected branches and tags**, allow only the branch rule `main`,
  and add no tag rules.
- Set the environment variable `RECOVERY_ENVIRONMENT_GUARD` to
  `production-recovery-main-only-v1`.
- Delete every repository-level duplicate recovery credential — keep these
  values only on the `production-recovery` environment.

GitHub API permissions cannot enforce an environment's deployment branch
policy from outside the UI, so verify it manually in repository settings.

### 5. Releasing

Push the revision to `main`, copy its exact full commit SHA, then dispatch
**Release production** with `revision=<that SHA>` and
`confirmation=RELEASE`. The workflow validates the SHA is an exact,
ancestor-verified commit from trusted `main`, stages a build, runs any pending
migrations only when required, verifies the staged deployment, promotes it,
and resumes production — pausing only after the revision is proven.

### 6. Recovery expectations

If a release fails after production is paused, the independent `recovery` job
(same workflow, `production-recovery` environment) runs automatically as a
watchdog and, separately, an in-job recovery step attempts safe recovery
first. Both authenticate against the *production* Vercel project's fingerprint
before touching anything, and only ever promote a previously verified target
or resume the still-compatible prior one — never an unverified commit. See
`scripts/recover-production-release.sh` and the `recovery` job in
`.github/workflows/release-production.yml` for the exact bounded stages and
timeouts.

### Crons (both profiles)

`vercel.json`'s `crons` array (`sync-shows`, `sync-listens`,
`contact-research`) is identical in both profiles — Vercel Cron calls these
regardless of how a release reached production, authenticating with
`CRON_SECRET`. Additional scheduled automation (outreach dispatch, playlist
refresh, token rotation, contact research/audit polling) runs from
`.github/workflows/*.yml` on their own schedules and is independent of which
deployment profile you choose.

### Migrations (both profiles)

Both profiles use `prisma migrate deploy` (`npm run db:migrate:deploy`),
which only applies already-committed migrations and never generates new ones
at deploy time. The hardened profile detects whether any migration is
pending (`npm run db:verify-targets`) and only runs it when required, as part
of the audited release job; the basic profile has no separate release job, so
your Vercel Build Command must run it directly (see step 4 above).

## Checking readiness

`npm run deployment:readiness` is an offline, read-only check of local
environment variables — it never makes a network call and never prints a
secret value, only whether each one is set/valid.

```bash
npm run deployment:readiness                      # basic profile (default)
npm run deployment:readiness -- --profile=hardened
npm run deployment:readiness -- --profile=hardened --json
DEPLOYMENT_PROFILE=hardened npm run deployment:readiness
```

The report separates:

- **Required core configuration** — database URLs, `APP_BASE_URL`,
  authentication, and (if set) fork-identity overrides. Required for either
  profile.
- **Required for the selected profile** — currently only the hardened
  profile's `CRON_SECRET` requirement, described above.
- **Optional integrations** — every other schema group (Resend, Spotify,
  stats.fm, EDMTrain, Google Sheets export, trajectory, contact agents).
  Never required and never affect the exit code.
- **Warnings** — reminders about Vercel project settings and GitHub
  repository/environment configuration this script *cannot* see or verify
  from local environment variables (git auto-deploy, Build Command,
  GitHub Environments, secrets, `HARDENED_RELEASE_REPOSITORY`). Confirm these
  manually; the script never claims to have checked them.

The process exits nonzero only when a required-core or required-for-the-
selected-profile item is missing or invalid. `--json` prints the same report
as machine-readable JSON with the same exit-code rule.

## How forks choose a profile

There is no single "mode" flag read by the app or by GitHub Actions. A fork's
profile is the sum of two independent, explicit, external choices:

1. `vercel.json`'s `git.deploymentEnabled.main` — `true` (or the `git` block
   removed) means Vercel auto-deploys pushes (basic); `false` means it does
   not, leaving `release-production.yml` as the only path to production.
2. Whether the fork has set its own `HARDENED_RELEASE_REPOSITORY` repository
   variable and configured the `production`/`production-recovery`
   GitHub Environments. Skipping this (the default for any repository other
   than this one) means the hardened workflow simply cannot run — every
   authorization check in it fails closed.

A fresh fork that does nothing beyond the [basic profile](#basic-profile-native-vercel-git-deploys)
steps gets a fully working deployment with no GitHub Actions configuration at
all. Adopting the hardened profile is strictly additive and opt-in.
