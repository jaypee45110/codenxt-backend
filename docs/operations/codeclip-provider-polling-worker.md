# codeClip Provider Polling Worker

## Purpose

The codeClip provider polling worker runs the generic provider polling runtime as
a separate process. The current production adapter registry is TikTok-only, so
the initial Railway service must be configured for TikTok polling and must not
replace the existing YouTube WebSub, reconciliation, or Data API runtime.

This document is a readiness runbook. It does not mean the Railway worker
service exists, has been deployed, is running recurring production cycles, or
has completed a live TikTok Display API end-to-end test.

## Start Command

Run from the repository root:

```bash
node scripts/codeclip-provider-polling-worker.js
```

No npm script is required for the initial Railway service. The script also
supports `--once` for a controlled one-shot smoke run.

## Environment

### Backend-Shared

| Variable | Classification | Notes |
| --- | --- | --- |
| `DATABASE_URL` | secret, required when enabled | Worker database connection. Do not use for local tests unless it points to a local database. |
| `CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS` | secret, required when a source with encrypted credentials is polled | Shared with backend credential lifecycle. |
| `CODECLIP_PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_VERSION` | config, required for credential lifecycle | Shared with backend credential lifecycle. |
| `CODECLIP_TIKTOK_CLIENT_KEY` | config, backend OAuth | Needed by TikTok OAuth flows; not a Display API token. |
| `CODECLIP_TIKTOK_CLIENT_SECRET` | secret, backend OAuth/refresh | Needed by TikTok token exchange and refresh flows. |
| `CODECLIP_TIKTOK_REDIRECT_URI` | config, backend OAuth callback | Must match TikTok app configuration. |

The worker's Display polling uses persisted credential access tokens. It does
not run OAuth, extend scopes, or perform automatic reauthorization. The TikTok
app must already be approved/configured for `video.list`, and the production
credential, binding, and poll source must be verified separately before live
recurring polling.

### Worker-Specific

All worker runtime variables use the `CODECLIP_PROVIDER_POLLING_WORKER_` prefix.

| Variable | Default | Classification | Notes |
| --- | --- | --- | --- |
| `ENABLED` | `true` | worker-specific | Set `false` for disabled deploy validation. |
| `PROVIDER` | `tiktok` | worker-specific | Keep `tiktok`; no YouTube migration. |
| `ENVIRONMENT` | `production` | worker-specific | `sandbox` or `production`. |
| `INTERVAL_MS` | `30000` | worker-specific | Recurring delay after successful cycle. |
| `LIMIT` | `25` | worker-specific | Due-source scan limit. |
| `CONCURRENCY` | `4` | worker-specific | Start with `2` or `4` for production. |
| `LEASE_MS` | `60000` | worker-specific | Claim lease for each source. |
| `OWNER_PREFIX` | `codeclip.provider.poll.worker` | worker-specific | Safe claim-owner prefix. |
| `FAILURE_BACKOFF_MS` | `30000` | worker-specific | Delay after global cycle failure. |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | worker-specific | Graceful stop wait. |
| `RUN_ON_START` | `true` | worker-specific | Run immediately on process start. |
| `ONE_SHOT` | `false` | worker-specific | Run one cycle and exit when `true`. |

Never paste secret values into Railway logs, docs, tickets, or shell history.

## Modes

### Disabled

Use this before the first enabled deploy:

```text
CODECLIP_PROVIDER_POLLING_WORKER_ENABLED=false
```

The entrypoint exits successfully without creating the runtime, opening a
database pool, registering signal handlers, or starting timers. This is useful
for config/readiness validation, but Railway restart policy should be checked:
a service that exits successfully may be restarted depending on service
configuration.

### One-Shot Smoke

Use after the Railway service exists and variables are configured:

```text
CODECLIP_PROVIDER_POLLING_WORKER_ENABLED=true
CODECLIP_PROVIDER_POLLING_WORKER_ONE_SHOT=true
CODECLIP_PROVIDER_POLLING_WORKER_RUN_ON_START=true
CODECLIP_PROVIDER_POLLING_WORKER_PROVIDER=tiktok
CODECLIP_PROVIDER_POLLING_WORKER_ENVIRONMENT=production
```

The expected result is exactly one supervised cycle and then a clean exit.
Railway restart policy should be checked here as well so a one-shot smoke does
not repeat unexpectedly.

### Recurring

Use only after disabled and one-shot validation:

```text
CODECLIP_PROVIDER_POLLING_WORKER_ENABLED=true
CODECLIP_PROVIDER_POLLING_WORKER_ONE_SHOT=false
CODECLIP_PROVIDER_POLLING_WORKER_RUN_ON_START=true
CODECLIP_PROVIDER_POLLING_WORKER_INTERVAL_MS=30000
CODECLIP_PROVIDER_POLLING_WORKER_LIMIT=25
CODECLIP_PROVIDER_POLLING_WORKER_CONCURRENCY=2
CODECLIP_PROVIDER_POLLING_WORKER_LEASE_MS=60000
CODECLIP_PROVIDER_POLLING_WORKER_FAILURE_BACKOFF_MS=30000
CODECLIP_PROVIDER_POLLING_WORKER_SHUTDOWN_TIMEOUT_MS=30000
```

The runtime uses completion-based scheduling and does not overlap cycles.
Increase concurrency only after supervised cycles are clean. Do not run
unattended recurring production polling until the monitoring gaps below are
accepted or addressed.

## Deploy Order

1. Deploy backend with schema ensures.
2. Confirm backend health/startup is green.
3. Confirm production database schema readiness.
4. Create a separate Railway service named `codeclip-provider-polling-worker`.
5. Use the same repository root and the start command above.
6. Configure worker-specific variables and required backend-shared secrets
   without printing secret values.
7. Deploy disabled or run one-shot smoke under supervision.
8. Verify safe startup/cycle/shutdown logs.
9. Confirm poll-source readiness.
10. Enable recurring mode later.

The standalone worker does not run schema ensures or migrations.

## Railway Service Plan

- Service name: `codeclip-provider-polling-worker`.
- Repository/root: same repository root as `codenxt-backend`.
- Start command: `node scripts/codeclip-provider-polling-worker.js`.
- Variables: worker-specific `CODECLIP_PROVIDER_POLLING_WORKER_*` values plus
  backend-shared database and credential/TikTok configuration.
- Status: this service has not been created or deployed by this runbook.

## Logs

Expected safe events:

```text
provider_polling_worker_started
provider_polling_cycle_started
provider_polling_cycle_completed
provider_polling_cycle_failed
provider_polling_worker_stopping
provider_polling_worker_stopped
provider_polling_worker_disabled
```

Logs contain aggregate fields only, such as provider, environment, cycle number,
status, counts, duration, and stable error code. They must not contain source
items, provider account IDs, checkpoints, claim owners, tokens, SQL, stack
traces, or raw provider errors.

## Smoke Checklist

1. Confirm service uses `node scripts/codeclip-provider-polling-worker.js`.
2. Confirm backend health and production schema readiness.
3. Confirm variables are set without printing secrets.
4. Confirm `PROVIDER=tiktok` and `ENVIRONMENT=production`.
5. Run disabled mode and verify controlled exit.
6. Run one-shot mode and verify one completed or failed-safe cycle.
7. Check Railway logs for the safe events above.
8. Confirm no token, account, source, checkpoint, SQL, or raw provider leakage.
9. Confirm the result is either expected zero-due or a controlled known source.
10. Confirm graceful exit/stop and database/poll-source status.
11. Confirm no TikTok messages, OAuth changes, or delivery side effects occur
   unless a known active poll source is intentionally due.
12. Confirm YouTube services/runtime remain unchanged.
13. Switch to recurring only after operator approval.

## Rollback

Set:

```text
CODECLIP_PROVIDER_POLLING_WORKER_ENABLED=false
```

or stop/scale down the Railway worker service. Do not delete poll sources or
credentials as a rollback step. Preserve checkpoints and the delivery ledger;
ordinary rollback should not reset durable polling state.

## Known Gaps

- No durable worker heartbeat table.
- No stale-worker alert.
- No email or paging alert for cycle failures.
- No automatic credential refresh-before-poll in the worker runtime.
- No live TikTok sandbox/production Display API E2E has been performed by this
  worker service.

These gaps do not block a supervised one-shot smoke. Monitoring and alerting are
required before unsupervised recurring production operation.

## Poll-Source Readiness

Before live recurring polling, verify all of the following without exposing raw
provider account identifiers:

- production database schema is ready;
- production TikTok credential exists and is usable;
- credential includes the exact `video.list` scope;
- active Episode binding exists for the TikTok account;
- active TikTok poll source exists or is explicitly activated;
- production adapter registry is available.

This runbook does not assert that any production poll source already exists.

## YouTube Isolation

This worker must be configured with `PROVIDER=tiktok`. The production adapter
registry currently registers TikTok only. Existing YouTube WebSub,
reconciliation, Data API, identities, and worker services remain unchanged.
