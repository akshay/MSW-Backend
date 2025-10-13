# Query Commands Documentation

## Overview
Three new query commands have been added to CommandProcessor for searching, ranking, and calculating entity ranks.

## New Commands

### 1. `search_by_name`
Search for entities by name pattern.

**Command Format:**
```json
{
  "type": "search_by_name",
  "entityType": "player",
  "namePattern": "alice",
  "worldId": 1,
  "limit": 100
}
```

**Parameters:**
- `entityType` (required): The type of entity to search
- `namePattern` (required): The name pattern to search for (case-insensitive, partial match)
- `worldId` (required): The world ID to search in
- `limit` (optional): Maximum number of results (default: 100)

**Response:**
```json
[
  {
    "entity_type": "player",
    "id": "player-123",
    "world_id": 1,
    "attributes": {"name": "Alice", "level": 5},
    "rank_scores": {"score": 100}
  },
  {
    "entity_type": "player",
    "id": "player-456",
    "world_id": 1,
    "attributes": {"name": "Alice2", "level": 3},
    "rank_scores": {"score": 50}
  }
]
```

**Implementation:**
- Calls `PersistentEntityManager.searchByName()`
- Uses SQL function `get_entities_by_name()`
- Results are cached for 5 minutes
- Excludes deleted entities
- Case-insensitive ILIKE matching

**Usage Example:**
```javascript
// Search for players with "dragon" in their name
{
  "type": "search_by_name",
  "entityType": "player",
  "namePattern": "dragon",
  "worldId": 1,
  "limit": 50
}
```

---

### 2. `calculate_rank`
Calculate the rank position of a specific entity.

**Command Format:**
```json
{
  "type": "calculate_rank",
  "entityType": "player",
  "entityId": "player-123",
  "worldId": 1,
  "rankKey": "score"
}
```

**Parameters:**
- `entityType` (required): The type of entity
- `entityId` (required): The ID of the entity to calculate rank for
- `worldId` (required): The world ID
- `rankKey` (required): The rank score key to use for ranking (e.g., "score", "level")

**Response:**
```json
{
  "entityId": "player-123",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "score",
  "score": 1500.5,
  "rank": 42,
  "totalEntities": 1000
}
```

**Response Fields:**
- `entityId`: The entity ID
- `entityType`: The entity type
- `worldId`: The world ID
- `rankKey`: The rank key used
- `score`: The entity's score value
- `rank`: The entity's rank position (1 = highest)
- `totalEntities`: Total number of ranked entities

**Implementation:**
- Calls `PersistentEntityManager.calculateEntityRank()`
- Uses optimized SQL query with CTEs
- Results are cached for 10 minutes
- Excludes deleted entities
- Rank 1 = highest score (by default)

**Usage Example:**
```javascript
// Get player's rank based on their XP score
{
  "type": "calculate_rank",
  "entityType": "player",
  "entityId": "player-123",
  "worldId": 1,
  "rankKey": "xp"
}
```

---

### 3. `get_rankings`
Get a ranked list of entities (leaderboard).

**Command Format:**
```json
{
  "type": "get_rankings",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "score",
  "sortOrder": "DESC",
  "limit": 100
}
```

**Parameters:**
- `entityType` (required): The type of entity
- `worldId` (required): The world ID
- `rankKey` (required): The rank score key to sort by
- `sortOrder` (optional): Sort direction - "DESC" (default) or "ASC"
- `limit` (optional): Maximum number of results (default: 100)

**Response:**
```json
[
  {
    "entity_type": "player",
    "id": "player-999",
    "world_id": 1,
    "attributes": {"name": "TopPlayer", "level": 99},
    "rank_scores": {"score": 9999},
    "rank_value": 9999
  },
  {
    "entity_type": "player",
    "id": "player-888",
    "world_id": 1,
    "attributes": {"name": "SecondPlace", "level": 95},
    "rank_scores": {"score": 8888},
    "rank_value": 8888
  }
]
```

**Implementation:**
- Calls `PersistentEntityManager.getRankedEntities()`
- Uses SQL function `get_ranked_entities()`
- Results are cached for 15 minutes
- Excludes deleted entities
- Returns entities ordered by rank_value

**Usage Example:**
```javascript
// Get top 10 players by score
{
  "type": "get_rankings",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "score",
  "sortOrder": "DESC",
  "limit": 10
}

// Get lowest level players
{
  "type": "get_rankings",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "level",
  "sortOrder": "ASC",
  "limit": 20
}
```

---

## Batch Processing

All three commands support batch processing through CommandProcessor:

```json
{
  "commands": [
    {
      "type": "search_by_name",
      "entityType": "player",
      "namePattern": "dragon",
      "worldId": 1
    },
    {
      "type": "calculate_rank",
      "entityType": "player",
      "entityId": "player-123",
      "worldId": 1,
      "rankKey": "score"
    },
    {
      "type": "get_rankings",
      "entityType": "player",
      "worldId": 1,
      "rankKey": "score",
      "limit": 10
    }
  ]
}
```

## Processing Details

### Parallel Execution
- All commands within each type are processed in parallel
- Different command types are also processed in parallel
- Results are returned in original command order

### Caching
- **search_by_name**: 5 minute TTL
- **calculate_rank**: 10 minute TTL
- **get_rankings**: 15 minute TTL
- Cache is invalidated when entities are updated/deleted

### Validation
- All commands require `entityType` and `worldId`
- Input is sanitized before SQL execution
- Invalid inputs are rejected with error messages

### Performance
- Queries use optimized SQL with proper indexes
- Results are cached in Redis
- Deleted entities are excluded via index
- Batch operations minimize round trips

## Error Handling

### Invalid Parameters
```json
{
  "error": "Command 0: entityType is required"
}
```

### Entity Not Found
For `calculate_rank`, if entity doesn't exist:
```json
{
  "entityId": "player-999",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "score",
  "score": null,
  "rank": null,
  "totalEntities": 0
}
```

### Empty Results
For `search_by_name` and `get_rankings`, returns empty array:
```json
[]
```

## Code References

- Command grouping: [CommandProcessor.js:209-217](util/CommandProcessor.js:209-217)
- Search processing: [CommandProcessor.js:387-407](util/CommandProcessor.js:387-407)
- Rank calculation: [CommandProcessor.js:409-429](util/CommandProcessor.js:409-429)
- Rankings processing: [CommandProcessor.js:431-454](util/CommandProcessor.js:431-454)

## Use Cases

### Leaderboards
```javascript
// Get top 100 players globally
{
  "type": "get_rankings",
  "entityType": "player",
  "worldId": 1,
  "rankKey": "global_score",
  "limit": 100
}
```

### Player Search
```javascript
// Find players by name for friend search
{
  "type": "search_by_name",
  "entityType": "player",
  "namePattern": "john",
  "worldId": 1,
  "limit": 20
}
```

### Rank Display
```javascript
// Show player their current rank
{
  "type": "calculate_rank",
  "entityType": "player",
  "entityId": "current-player-id",
  "worldId": 1,
  "rankKey": "pvp_rating"
}
```

### Multi-Query Dashboard
```javascript
{
  "commands": [
    // Get player's rank
    {"type": "calculate_rank", "entityType": "player", "entityId": "p1", "worldId": 1, "rankKey": "score"},
    // Get top 10 around player
    {"type": "get_rankings", "entityType": "player", "worldId": 1, "rankKey": "score", "limit": 10},
    // Search for guild members
    {"type": "search_by_name", "entityType": "player", "namePattern": "guild", "worldId": 1}
  ]
}
```
