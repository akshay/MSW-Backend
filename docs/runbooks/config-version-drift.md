# Runbook: ConfigVersionDrift

## Trigger
More than 5% of clients are not on current version after rollout.

## Immediate Checks
1. `GET /config/version?environment=<env>`
2. `GET /config/alerts?environment=<env>`
3. `GET /dashboard/config`

## Remediation
1. Verify latest publish completed and manifest points to expected version.
2. Check clients receiving `requiresFullSync`; force full sync if needed.
3. If bad rollout suspected, execute rollback:
   - `node scripts/publish-config.js rollback --version <N> --env <env>`

## Exit Criteria
- Drift drops below 5% for two consecutive checks.
