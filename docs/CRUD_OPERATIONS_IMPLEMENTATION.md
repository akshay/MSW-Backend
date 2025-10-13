# Create/Update/Delete Operations Implementation

## Overview
This implementation adds proper create, update, and delete operations to the entity save system with validation and soft deletes.

## Changes Made

### 1. Database Schema Changes

#### Prisma Schema ([schema.prisma](prisma/schema.prisma:18))
- Added `isDeleted` column to Entity model (default: false)
- Added index `idx_entity_deleted` on `(entityType, worldId, isDeleted)` for efficient filtering

#### Database Migration ([add_is_deleted_column.sql](prisma/migrations/add_is_deleted_column.sql))
- Adds `is_deleted BOOLEAN NOT NULL DEFAULT false` column to entities table
- Creates index for filtering deleted entities

### 2. SQL Function Updates ([add_jsonb_functions.sql](prisma/migrations/add_jsonb_functions.sql))

#### `batch_upsert_entities_partial` - Complete Rewrite
Now returns `JSONB` instead of `INT` and includes detailed operation results.

**Input Format:**
```json
[
  {
    "entity_type": "player",
    "id": "player-123",
    "world_id": 1,
    "attributes": {"name": "Alice"},
    "rank_scores": {"score": 100},
    "is_create": false,
    "is_delete": false
  }
]
```

**Output Format:**
```json
{
  "results": [
    {"success": true, "entity_type": "player", "id": "player-123", "operation": "update"}
  ],
  "total": 1
}
```

**Operation Logic:**
- **CREATE** (`is_create: true`):
  - ✅ Succeeds if entity doesn't exist or is deleted
  - ❌ Fails with `ENTITY_ALREADY_EXISTS` if entity exists and not deleted
  - Sets `is_deleted = false` and `version = 1`

- **UPDATE** (neither flag is true):
  - ✅ Succeeds if entity exists and not deleted
  - ❌ Fails with `ENTITY_NOT_FOUND` if entity doesn't exist or is deleted
  - Increments `version` by 1
  - Sets `is_deleted = false` (resurrects if was deleted)

- **DELETE** (`is_delete: true`):
  - ✅ Succeeds if entity exists and not deleted
  - ❌ Fails with `ENTITY_NOT_FOUND` if entity doesn't exist or already deleted
  - Sets `is_deleted = true` and increments `version`
  - Does NOT remove the entity from the database (soft delete)

### 3. Query Updates - Exclude Deleted Entities

All read operations now filter out deleted entities:

#### `batchLoad` ([PersistentEntityManager.js](util/PersistentEntityManager.js:151))
```javascript
where: {
  entityType,
  id: { in: entityIds },
  worldId,
  isDeleted: false  // Added
}
```

#### `calculateEntityRank` ([PersistentEntityManager.js](util/PersistentEntityManager.js:394))
```sql
WHERE entity_type = $1
  AND id = $2
  AND world_id = $3
  AND is_deleted = false  -- Added
```

#### `get_ranked_entities` ([add_jsonb_functions.sql](prisma/migrations/add_jsonb_functions.sql:228))
```sql
WHERE e.entity_type = ...
  AND e.world_id = ...
  AND e.is_deleted = false  -- Added
  AND e.rank_scores ? ...
```

#### `get_entities_by_name` ([add_jsonb_functions.sql](prisma/migrations/add_jsonb_functions.sql:254))
```sql
WHERE e.entity_type = ...
  AND e.world_id = ...
  AND e.is_deleted = false  -- Added
  AND e.attributes->>'name' ILIKE ...
```

### 4. PersistentEntityManager Updates

#### `batchSavePartial` ([PersistentEntityManager.js](util/PersistentEntityManager.js:210))
Now accepts `isCreate` and `isDelete` boolean flags:

```javascript
async batchSavePartial(updates) {
  // updates format:
  // [{ entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }]
}
```

#### `performBatchUpsert` ([PersistentEntityManager.js](util/PersistentEntityManager.js:254))
- Passes operation flags to SQL function
- Logs failed operations from the result
- Skips stream updates for delete operations

## Usage Examples

### Creating a New Entity
```javascript
await entityManager.batchSavePartial([
  {
    entityType: 'player',
    entityId: 'player-123',
    worldId: 1,
    attributes: { name: 'Alice', level: 1 },
    rankScores: { score: 0 },
    isCreate: true  // Mark as create
  }
]);
// ✅ Success if entity doesn't exist
// ❌ Fails if entity already exists
```

### Updating an Existing Entity
```javascript
await entityManager.batchSavePartial([
  {
    entityType: 'player',
    entityId: 'player-123',
    worldId: 1,
    attributes: { level: 2 },
    rankScores: { score: 100 }
    // No flags = update operation
  }
]);
// ✅ Success if entity exists and not deleted
// ❌ Fails if entity doesn't exist or is deleted
```

### Deleting an Entity (Soft Delete)
```javascript
await entityManager.batchSavePartial([
  {
    entityType: 'player',
    entityId: 'player-123',
    worldId: 1,
    attributes: {},  // Can be empty for deletes
    isDelete: true  // Mark as delete
  }
]);
// ✅ Success if entity exists and not deleted
// ❌ Fails if entity doesn't exist or already deleted
```

### Mixed Operations in a Batch
```javascript
await entityManager.batchSavePartial([
  { entityType: 'player', entityId: 'p1', worldId: 1, attributes: {...}, isCreate: true },
  { entityType: 'player', entityId: 'p2', worldId: 1, attributes: {...} },  // update
  { entityType: 'player', entityId: 'p3', worldId: 1, attributes: {}, isDelete: true }
]);
```

## Validation Rules

| Operation | Entity Exists & Not Deleted | Entity Doesn't Exist | Entity Deleted | Result |
|-----------|----------------------------|---------------------|----------------|--------|
| CREATE    | ❌ `ENTITY_ALREADY_EXISTS` | ✅ Creates entity   | ✅ Resurrects  | Success or Error |
| UPDATE    | ✅ Updates entity          | ❌ `ENTITY_NOT_FOUND` | ❌ `ENTITY_NOT_FOUND` | Success or Error |
| DELETE    | ✅ Soft deletes            | ❌ `ENTITY_NOT_FOUND` | ❌ `ENTITY_NOT_FOUND` | Success or Error |

## Behavior Details

### Soft Delete
- Deleted entities remain in the database with `is_deleted = true`
- Deleted entities do NOT appear in:
  - Load operations
  - Rankings
  - Name searches
  - Rank calculations
- Deleted entities still increment version number
- Create operation on a deleted entity will resurrect it

### Version Tracking
- **CREATE**: Sets `version = 1`
- **UPDATE**: Increments `version` by 1
- **DELETE**: Increments `version` by 1
- Version tracking works with versioned loads implementation

### Cache Behavior
- All operations invalidate the newest version cache
- Versioned caches (with version in key) are NOT invalidated
- Delete operations do NOT send stream updates

### Error Handling
- SQL function returns detailed success/failure for each entity
- Failed operations are logged with error codes
- Batch processing continues even if some operations fail
- Each operation result includes: `{success, error?, entity_type, id, operation?}`

## Migration Steps

1. Run the database migration to add is_deleted column:
   ```sql
   -- Run add_is_deleted_column.sql
   ```

2. Update SQL functions:
   ```sql
   -- Run updated add_jsonb_functions.sql
   ```

3. Deploy updated PersistentEntityManager code

4. Update client code to:
   - Include `isCreate: true` for new entities
   - Include `isDelete: true` for deletions
   - Omit both flags for updates (default behavior)
   - Handle validation errors (`ENTITY_ALREADY_EXISTS`, `ENTITY_NOT_FOUND`)

## Error Codes

- `ENTITY_ALREADY_EXISTS`: Attempted to create an entity that already exists
- `ENTITY_NOT_FOUND`: Attempted to update/delete an entity that doesn't exist or is already deleted

## Benefits

1. **Proper CRUD Semantics**: Clear distinction between create, update, and delete
2. **Validation**: Prevents invalid operations (updating non-existent entities, etc.)
3. **Soft Deletes**: Deleted data is preserved for audit/recovery
4. **Atomicity**: Each operation validates and executes atomically
5. **Detailed Feedback**: Know exactly which operations succeeded or failed
6. **Performance**: Batch operations remain efficient
7. **Backward Compatible**: Omitting flags defaults to update behavior
