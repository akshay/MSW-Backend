# Batching Optimization for Query Methods

## Overview

Optimized all query methods (`calculateEntityRank`, `getRankedEntities`, `searchByName`) to use batch operations in CommandProcessor. **Removed unbatched versions** to enforce efficient batching pattern throughout the codebase, reducing cache round-trips and improving performance.

## Changes

### 1. Replaced `getRankedEntities` with `batchGetRankedEntities`

**Location**: [util/PersistentEntityManager.js:346-431](../util/PersistentEntityManager.js#L346)

Implements efficient batching for rankings queries with:
- **Batched cache reads**: Single `mget` call for all requests
- **Parallel database queries**: Only for cache misses
- **Batched cache writes**: Single `mset` call for all new results

### 2. Replaced `searchByName` with `batchSearchByName`

**Location**: [util/PersistentEntityManager.js:565-648](../util/PersistentEntityManager.js#L565)

Implements efficient batching for name search queries with:
- **Batched cache reads**: Single `mget` call for all requests
- **Parallel database queries**: Only for cache misses
- **Batched cache writes**: Single `mset` call for all new results

### 3. Replaced `calculateEntityRank` with `batchCalculateEntityRank`

**Location**: [util/PersistentEntityManager.js:433-563](../util/PersistentEntityManager.js#L433)

Implements efficient batching for rank calculations with:
- **Batched cache reads**: Single `mget` call for all requests
- **Parallel database queries**: Only for cache misses
- **Batched cache writes**: Single `mset` call for all new results

### 4. Updated CommandProcessor

All three processor methods updated to use batch operations:

#### `processBatchedGetRankings`
**Location**: [util/CommandProcessor.js:424-442](../util/CommandProcessor.js#L424)

**Before**:
```javascript
const results = await Promise.all(
  getRankingsCommands.map(cmd =>
    this.persistentManager.getRankedEntities(...)
  )
);
```

**After**:
```javascript
const requests = getRankingsCommands.map(cmd => ({
  entityType: cmd.entityType,
  worldId: cmd.worldId,
  rankKey: cmd.rankKey,
  sortOrder: cmd.sortOrder || 'DESC',
  limit: cmd.limit || 100
}));

const results = await this.persistentManager.batchGetRankedEntities(requests);
```

#### `processBatchedSearchByName`
**Location**: [util/CommandProcessor.js:384-402](../util/CommandProcessor.js#L384)

**Before**:
```javascript
const results = await Promise.all(
  searchCommands.map(cmd =>
    this.persistentManager.searchByName(...)
  )
);
```

**After**:
```javascript
const requests = searchCommands.map(cmd => ({
  entityType: cmd.entityType,
  namePattern: cmd.namePattern,
  worldId: cmd.worldId,
  limit: cmd.limit || 100
}));

const results = await this.persistentManager.batchSearchByName(requests);
```

#### `processBatchedCalculateRank`
**Location**: [util/CommandProcessor.js:404-422](../util/CommandProcessor.js#L404)

**Before**:
```javascript
const results = await Promise.all(
  calculateRankCommands.map(cmd =>
    this.persistentManager.calculateEntityRank(...)
  )
);
```

**After**:
```javascript
const requests = calculateRankCommands.map(cmd => ({
  entityType: cmd.entityType,
  worldId: cmd.worldId,
  entityId: cmd.entityId,
  rankKey: cmd.rankKey
}));

const results = await this.persistentManager.batchCalculateEntityRank(requests);
```

## Performance Impact

### Cache Operations
- **Before**: N individual `get` calls + N individual `set` calls per method
- **After**: 1 `mget` call + 1 `mset` call per method
- **Reduction**: O(N) → O(1) cache round-trips

### Database Queries
- **Before**: Up to N queries wrapped in Promise.all
- **After**: Cache misses processed in parallel
- **Improvement**: Better connection pooling, reduced overhead, same parallelism

### Example Scenario
For 10 queries with 50% cache hit rate:
- **Cache operations**: 20 → 2 (10x reduction)
- **Database queries**: 5 parallel queries for misses (same)
- **Expected speedup**: 3-5x due to reduced cache round-trips

## Tests

### PersistentEntityManager Tests

Added comprehensive test coverage in [tests/PersistentEntityManager.test.js](../tests/PersistentEntityManager.test.js):

#### `batchGetRankedEntities` (lines 421-490)
1. ✅ Empty array handling
2. ✅ All cache hits scenario
3. ✅ All cache misses scenario
4. ✅ Mixed cache hits/misses scenario

#### `batchSearchByName` (lines 492-561)
1. ✅ Empty array handling
2. ✅ All cache hits scenario
3. ✅ All cache misses scenario
4. ✅ Mixed cache hits/misses scenario

#### `batchCalculateEntityRank` (lines 563-634)
1. ✅ Empty array handling
2. ✅ All cache hits scenario
3. ✅ All cache misses scenario
4. ✅ Mixed cache hits/misses scenario

### CommandProcessor Tests

Updated tests in [tests/CommandProcessor.test.js](../tests/CommandProcessor.test.js):

- ✅ `processBatchedSearchByName` (lines 587-636)
- ✅ `processBatchedCalculateRank` (lines 638-674)
- ✅ `processBatchedGetRankings` (lines 677-726)

## Breaking Changes

⚠️ **Removed unbatched methods**: The following methods no longer exist:
- `getRankedEntities(entityType, worldId, rankKey, options)`
- `searchByName(entityType, namePattern, worldId, limit)`
- `calculateEntityRank(entityType, worldId, entityId, rankKey)` (removed from earlier iteration)

All callers must now use the batch versions:
- `batchGetRankedEntities(requests)`
- `batchSearchByName(requests)`
- `batchCalculateEntityRank(requests)`

## Rationale for Removing Unbatched Methods

1. **Prevents inefficient usage**: Forces all code to use efficient batching
2. **Simpler codebase**: Single implementation path reduces maintenance burden
3. **Consistent performance**: No accidental N+1 query patterns
4. **CommandProcessor is sole caller**: No other code paths require single-item queries

## Future Optimizations

Potential improvements:
1. Group database queries by (entityType, worldId) to use fewer queries
2. Add batch size limits for very large requests
3. Consider caching negative results (entity not found)
4. Implement adaptive batching based on cache hit rates
