# Versioned Loads Implementation

## Overview
This implementation adds versioned entity loading to the PersistentEntityManager, allowing clients to request only the changes that occurred after a specific version number.

## Changes Made

### 1. Database Schema Changes

#### Prisma Schema ([schema.prisma](prisma/schema.prisma))
- Added `version` column to Entity model (default: 1)
- Added index `idx_entity_version` on `(entityType, id, version)` for efficient version queries

#### Database Migration ([add_version_column.sql](prisma/migrations/add_version_column.sql))
- Adds `version INT NOT NULL DEFAULT 0` column to entities table
- Creates index for version-based queries

### 2. SQL Function Updates ([add_jsonb_functions.sql](prisma/migrations/add_jsonb_functions.sql))

#### `upsert_entity_partial`
- Now returns `version` in the result set
- Increments `version` on UPDATE operations (version = entities.version + 1)
- Sets `version = 1` for new INSERT operations

#### `batch_upsert_entities_partial`
- Increments `version` on UPDATE operations
- Sets `version = 1` for new INSERT operations

### 3. PersistentEntityManager Updates ([PersistentEntityManager.js](util/PersistentEntityManager.js))

#### New Method: `getCacheKey(entityType, entityId, worldId, version = null)`
- Updated to support versioned cache keys
- When `version` is provided: `entity:${entityType}:${worldId}:${entityId}:v${version}`
- When `version` is null: `entity:${entityType}:${worldId}:${entityId}` (newest version)

#### New Method: `computeEntityDiff(oldEntity, newEntity)`
- Compares two entity versions
- Returns only the attributes and rankScores that changed between versions
- Includes attributes/rankScores that were deleted (set to InputValidator.NULL_MARKER)

#### Updated Method: `batchLoad(requests)`
Enhanced to support versioned loading:

1. **Input**: Accepts `version` parameter in each request (default: 0)
2. **Caching Strategy**:
   - Stores both newest version (no version in key) and versioned entities (version in key)
   - Checks cache for both newest and versioned entities
3. **Version Comparison**:
   - If both newest and versioned entity found in cache: returns diff
   - If only newest found: returns full entity
   - If cache miss: loads from database, caches both versions, returns diff if applicable
4. **Return Value**: Entity with only changed attributes and the current version number

#### Cache Invalidation: `performBatchUpsert(mergedUpdates)`
- **No changes needed** - Already working correctly
- Invalidates only newest version cache (without version in key)
- Versioned cache entries (with version numbers) are NOT invalidated
- This is correct because old versions are immutable

## Usage Example

### Loading Full Entity (No Version Specified)
```javascript
const requests = [
  { entityType: 'player', entityId: 'player-123', worldId: 1 }
];
const results = await entityManager.batchLoad(requests);
// Returns: { entityType, entityId, worldId, attributes: {...}, rankScores: {...}, version: 5 }
```

### Loading Changes Since Version 3
```javascript
const requests = [
  { entityType: 'player', entityId: 'player-123', worldId: 1, version: 3 }
];
const results = await entityManager.batchLoad(requests);
// Returns: { entityType, entityId, worldId, attributes: {name: "NewName"}, rankScores: {score: 100}, version: 5 }
// Only returns attributes that changed after version 3
```

## Cache Behavior

### Load Operations
1. **Newest Version Cache Key**: `entity:player:1:player-123`
   - Invalidated on saves
   - Always stores the latest entity state

2. **Versioned Cache Key**: `entity:player:1:player-123:v3`
   - Never invalidated (immutable)
   - Stores entity state at specific version

### Save Operations
- Increments version in database
- Invalidates only newest version cache
- Versioned caches remain valid (old versions don't change)

## Benefits

1. **Bandwidth Reduction**: Clients only receive changed data
2. **Efficient Updates**: No need to compare full entities on client side
3. **Cache Efficiency**: Versioned entities are cached and never invalidated
4. **Backward Compatible**: If version is 0 or not specified, full entity is returned
5. **Optimistic Locking**: Version numbers can be used for conflict detection

## Migration Steps

1. Run the database migration to add version column:
   ```sql
   -- Run add_version_column.sql
   ```

2. Update SQL functions:
   ```sql
   -- Run updated add_jsonb_functions.sql
   ```

3. Deploy updated PersistentEntityManager code

4. Update client code to:
   - Store version numbers from load responses
   - Include version in subsequent load requests
   - Merge returned diffs with local state
