# Config Hot-Reload API

This document covers the config versioning endpoints and publish tooling for hot-reload clients.

## Endpoints

### GET `/config/version`

Returns current snapshot metadata for an environment.

**Query**
- `environment` (required): `staging` or `production`

**Response**
```json
{
  "currentVersion": 42,
  "manifestId": "4_z8f1..."
}
```

---

### POST `/cloudrun` (config sync integrated)

Config sync now rides on the existing CloudRun request/response cycle.

**Request**
```json
{
  "environment": "staging",
  "encrypted": "...",
  "nonce": "...",
  "auth": "...",
  "worldInstanceId": "...",
  "commands": {},
  "configSync": {
    "clientVersion": 41
  }
}
```

**No change response fragment**
```json
{
  "configSync": {
    "noChange": true,
    "currentVersion": 42
  }
}
```

**Diff response fragment**
```json
{
  "configSync": {
    "snapshotVersion": 42,
    "manifestId": "4_z8f1...",
    "diff": {
      "fromVersion": 41,
      "toVersion": 42,
      "files": {
        "items.json": {
          "sword_001": {
            "damage": 120
          },
          "old_item": "$$__NULL__$$"
        },
      }
    }
  }
}
```

**Too old response fragment**
```json
{
  "configSync": {
    "requiresFullSync": true,
    "currentVersion": 42
  }
}
```

---

### POST `/config/rollback`

Rolls active manifest back to a prior version and publishes a new snapshot.

**Request**
```json
{
  "environment": "staging",
  "targetVersion": 40
}
```

**Response**
```json
{
  "success": true,
  "newVersion": 43,
  "message": "Rolled back staging config to version 40"
}
```

---

### GET `/config/health/:version`

Returns aggregate health data for a specific version.

**Query**
- `environment` (required)

**Response**
```json
{
  "version": 42,
  "currentVersion": 43,
  "clientsOnVersion": 87,
  "versionErrors": 2,
  "adoptionRate": 91.58,
  "bad": false,
  "reason": null,
  "lastErrorSummary": "..."
}
```

---

### POST `/config/health/mark-bad`

Marks a version as bad for operations and monitoring.

**Request**
```json
{
  "environment": "staging",
  "version": 42,
  "reason": "broken reward tables"
}
```

---

### GET `/config/alerts`

Evaluates active alert conditions for an environment.

**Query**
- `environment` (required)

## Diff Format

Diffs are custom per-file deep JSON patches:
- Added/updated value → direct JSON value at the changed path
- Deleted object key → `$$__NULL__$$` (NULL marker)
- Arrays are replaced wholesale at the array path

The marker must never appear as normal config data. Publishing validates and blocks marker collisions.

Only mapped hot-reload files are synced:
- `global.json`, `item.json`, `items.json`, `job.json`, `jobs.json`, `map.json`, `maps.json`
- `mob.json`, `mobs.json`, `npc.json`, `npcs.json`, `cloud.json`, `script.json`
- `ui_plans.json`, `ui_plans/index.json`, `provider.json`

## CLI

### Publish
```bash
node scripts/publish-config.js --env staging --label "balance update"
```

### Dry-run validation
```bash
node scripts/publish-config.js --env staging --dry-run
```

### Rollback
```bash
node scripts/publish-config.js rollback --version 41 --env staging
```

### Shard `ui_plans.json`
```bash
node scripts/shard-ui-plans.js --input ../MSW-Tools/data/config/ui_plans.json --output config/ui_plans
```

## Error Codes

- `400` invalid input (`environment`, version fields)
- `404` manifest/version not found
- `409` publish lock already held
- `500` backend/service failure

## Troubleshooting

- `requiresFullSync: true` frequently: increase publish cadence or raise `CONFIG_MAX_VERSION_GAP_FOR_DIFF`.
- Rollback blocked with lock conflict: wait for active publish to finish, then retry.
- High sync errors: inspect `/config/alerts` and runbooks under `docs/runbooks/`.
