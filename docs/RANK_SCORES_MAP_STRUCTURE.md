# Rank Scores Map Structure

## Overview

The `rankScores` attribute now uses a `map<int32, int64>` structure to support partitioned scoring systems. This allows entities to have different scores for different partitions (e.g., different game modes, regions, or categories).

## Data Structure

### Database Schema
The `rankScores` field in the `entities` table is stored as JSONB with a nested map structure:

```json
{
  "scoreType1": {
    "partitionKey1": value1,
    "partitionKey2": value2
  },
  "scoreType2": {
    "partitionKey1": value3,
    "partitionKey2": value4
  }
}
```

### Example
```json
{
  "kills": {
    "1": 100,
    "2": 150,
    "3": 75
  },
  "score": {
    "1": 5000,
    "2": 7500
  }
}
```

In this example:
- The entity has kill counts for partitions 1, 2, and 3
- The entity has scores for partitions 1 and 2
- Each partition key is an int32 (stored as string in JSON)
- Each value is an int64

## API Usage

### Saving Entities with Rank Scores

When saving entities, you can provide rank scores in two formats:

#### Format 1: Flattened (Recommended)
In the `attributes` field, use the format `"scoreType:partitionKey"`:

```javascript
{
  entityType: "player",
  entityId: "player123",
  worldId: 1,
  attributes: {
    name: "John",
    "kills:1": 100,      // kills for partition 1
    "kills:2": 150,      // kills for partition 2
    "score:1": 5000      // score for partition 1
  }
}
```

The system will automatically extract these and convert them to the nested structure in `rankScores`.

#### Format 2: Nested (Legacy Support)
For backward compatibility, single-value rank scores without a partition key will be assigned to partition "0":

```javascript
{
  entityType: "player",
  entityId: "player123",
  worldId: 1,
  attributes: {
    name: "John",
    kills: 100    // Will be stored as kills["0"] = 100
  }
}
```

### Calculating Rank

To calculate an entity's rank, use the `rank` command with a `rankKey` in the format `"scoreType:partitionKey"`:

```javascript
{
  rank: [
    {
      entityType: "player",
      entityId: "player123",
      worldId: 1,
      rankKey: "kills:1"    // Format: "scoreType:partitionKey"
    }
  ]
}
```

Response:
```javascript
{
  rank: [
    {
      entityId: "player123",
      entityType: "player",
      worldId: 1,
      rankKey: "kills:1",
      score: 100,
      rank: 5,
      totalEntities: 100
    }
  ]
}
```

### Getting Top Rankings

To get the top-ranked entities for a specific partition, use the `top` command:

```javascript
{
  top: [
    {
      entityType: "player",
      worldId: 1,
      rankKey: "kills:1",    // Format: "scoreType:partitionKey"
      sortOrder: "DESC",
      limit: 10
    }
  ]
}
```

Response:
```javascript
{
  top: [
    [
      {
        entity_type: "player",
        id: "player456",
        world_id: 1,
        attributes: { ... },
        rank_scores: { "kills": { "1": 200, "2": 150 } },
        rank_value: 200
      },
      // ... more entities
    ]
  ]
}
```

## Implementation Details

### Database Functions

The following database functions have been updated to support the map structure:

1. **`get_ranked_entities()`** - Now accepts rankKey in format "scoreType:partitionKey" and queries the nested structure
2. **`batch_upsert_entities_partial()`** - Performs deep merge of rank scores to preserve partition data
3. **`get_entities_by_name()`** - Updated to include environment parameter

### Application Layer

#### CommandProcessor
- Extracts rank scores from attributes during save operations
- Converts flattened format `"scoreType:partitionKey"` to nested map structure
- Supports legacy format (assigns to partition "0")

#### PersistentEntityManager
- Validates rankKey format (must contain ":")
- Parses rankKey into scoreType and partitionKey
- Queries database using nested JSONB paths
- Caches rank calculations per partition

#### EphemeralEntityManager
- Stores rankScores in nested map structure in Redis
- Deep merges partition maps during updates
- Flattens to stream format for updates

## Migration

A new migration has been created at:
```
prisma/migrations/20251130200308_update_rank_functions_for_map/migration.sql
```

This migration updates all database functions to support the new map structure. Run the migration with:

```bash
npx prisma migrate deploy
```

## Backward Compatibility

The system maintains backward compatibility:
- Single-value rank scores are automatically assigned to partition "0"
- Existing data without partition keys will continue to work
- New code can use either format

## Performance Considerations

1. **Indexing**: The existing GIN index on `rankScores` supports efficient queries on nested structures
2. **Caching**: Rank calculations are cached per partition to reduce database load
3. **Batch Operations**: All operations support batching for optimal performance

## Example Use Cases

### Game Modes
```javascript
// Different kill counts per game mode
{
  "kills": {
    "1": 100,  // Mode 1: Team Deathmatch
    "2": 75,   // Mode 2: Free For All
    "3": 150   // Mode 3: Capture the Flag
  }
}
```

### Regions
```javascript
// Different scores per region
{
  "score": {
    "1": 5000,  // North America
    "2": 7500,  // Europe
    "3": 6000   // Asia
  }
}
```

### Time Periods
```javascript
// Different statistics per season
{
  "rating": {
    "1": 1500,  // Season 1
    "2": 1750,  // Season 2
    "3": 1600   // Season 3
  }
}
```
