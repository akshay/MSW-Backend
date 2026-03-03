# Runbook: ConfigSyncErrors

## Trigger
`ConfigSyncErrors` alert fires (>1% sync request errors).

## Immediate Checks
1. `GET /config/alerts?environment=<env>`
2. `GET /metrics/prometheus` and inspect `config_sync_requests_total`.
3. Check server logs for `/config/sync` exceptions.

## Remediation
1. Validate current manifest exists and is readable.
2. Verify diff cache keys for requested versions are present.
3. If clients are too far behind, return/accept full sync path and force refresh.
4. Mark known-bad versions:
   - `POST /config/health/mark-bad`

## Exit Criteria
- Sync error rate returns under 1% and alert clears.
