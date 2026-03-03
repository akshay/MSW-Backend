# Runbook: ConfigRollback

## Trigger
Rollback requested manually or rollback alert emitted.

## Procedure
1. Identify target stable version from recent manifests.
2. Run rollback:
   - `node scripts/publish-config.js rollback --version <target> --env <env>`
3. Verify:
   - `GET /config/version?environment=<env>`
   - `GET /config/health/<newVersion>?environment=<env>`

## Post-Rollback
1. Monitor client adoption and sync error rate.
2. Create follow-up publish plan for fixed version.

## Exit Criteria
- New rollback snapshot active and adoption rate trending upward.
