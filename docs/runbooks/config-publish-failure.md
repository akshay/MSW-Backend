# Runbook: ConfigPublishFailure

## Trigger
Publish fails or publish duration exceeds 120 seconds.

## Immediate Checks
1. Validate credentials and bucket variables in environment.
2. Run dry-run validation:
   - `node scripts/publish-config.js --env <env> --dry-run`
3. Check lock contention:
   - `GET /config/alerts?environment=<env>`

## Remediation
1. Resolve lock contention and retry publish.
2. If validation fails on NULL marker, fix source config and republish.
3. If B2 upload fails repeatedly, rollback to last known good version.

## Exit Criteria
- Successful publish with expected snapshot version and no active publish alert.
