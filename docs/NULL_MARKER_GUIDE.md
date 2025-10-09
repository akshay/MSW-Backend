# NULL_MARKER Guide: Removing Keys from Nested JSON Attributes

## Overview

The MSW Backend supports a special marker string to remove keys from nested JSON attributes during entity save operations. This is necessary because actual `null` values are never passed as input, but you still need a way to signal that a key should be deleted from the entity's attributes or rank scores.

## The NULL_MARKER

**Value:** `$$__NULL__$$`

This special string uses double dollar signs and underscores to ensure it will never collide with actual user data.

## Usage

### Removing an Attribute

When saving an entity, if you want to remove a key from the `attributes` or `rank_scores` JSON, set its value to the NULL_MARKER:

```json
{
  "type": "save_entity",
  "entityType": "PlayerCharacter",
  "entityId": "player123",
  "worldId": 1,
  "attributes": {
    "name": "NewName",
    "temporary_buff": "$$__NULL__$$"
  }
}
```

**Result:** The entity will be updated with the new name, and the `temporary_buff` key will be completely removed from the attributes JSON.

### Removing a Rank Score

The same approach works for rank scores:

```json
{
  "type": "save_entity",
  "entityType": "PlayerCharacter",
  "entityId": "player123",
  "worldId": 1,
  "attributes": {
    "level": 50
  },
  "rankScores": {
    "pvp_score": 1500,
    "seasonal_rank": "$$__NULL__$$"
  }
}
```

**Result:** The `seasonal_rank` key will be removed from the rank_scores JSON.

## How It Works

### 1. Client/Game Side
- When you need to delete a key, set its value to `"$$__NULL__$$"`
- Send the save command as usual

### 2. Backend Processing

#### InputValidator (util/InputValidator.js)
- Detects the NULL_MARKER during attribute sanitization
- Separates keys to remove from keys to update
- Returns both `sanitized` attributes and `keysToRemove` arrays

#### EphemeralEntityManager (Redis/RedisJSON)
- For new entities: Ignores NULL_MARKER values (nothing to remove)
- For existing entities: Uses `JSON.DEL` to atomically remove the keys marked with NULL_MARKER
- Stream updates exclude NULL_MARKER values

#### PersistentEntityManager (PostgreSQL/CockroachDB)
- Processes NULL_MARKER values and builds `attributes_keys_to_remove` and `rank_scores_keys_to_remove` arrays
- Passes these arrays to the database function
- Stream updates exclude NULL_MARKER values

#### Database Function (batch_upsert_entities_partial)
- Merges new attributes with existing attributes
- Uses PostgreSQL's JSONB `-` operator to remove keys listed in the `*_keys_to_remove` arrays
- Performs atomic upsert with cleaned data

## Examples

### Example 1: Simple Key Removal

**Before:**
```json
{
  "entityType": "PlayerCharacter",
  "id": "player123",
  "attributes": {
    "name": "Hero",
    "health": 100,
    "mana": 50,
    "temporary_buff": "shield"
  }
}
```

**Save Command:**
```json
{
  "type": "save_entity",
  "entityType": "PlayerCharacter",
  "entityId": "player123",
  "worldId": 1,
  "attributes": {
    "temporary_buff": "$$__NULL__$$"
  }
}
```

**After:**
```json
{
  "entityType": "PlayerCharacter",
  "id": "player123",
  "attributes": {
    "name": "Hero",
    "health": 100,
    "mana": 50
  }
}
```

### Example 2: Multiple Operations

You can update some keys and remove others in the same operation:

```json
{
  "type": "save_entity",
  "entityType": "PlayerCharacter",
  "entityId": "player123",
  "worldId": 1,
  "attributes": {
    "health": 150,
    "mana": "$$__NULL__$$",
    "stamina": 200,
    "old_quest_data": "$$__NULL__$$"
  }
}
```

**Result:**
- `health` updated to 150
- `mana` key removed
- `stamina` set to 200
- `old_quest_data` key removed

### Example 3: Rank Score Cleanup

```json
{
  "type": "save_entity",
  "entityType": "PlayerCharacter",
  "entityId": "player123",
  "worldId": 1,
  "attributes": {
    "level": 60
  },
  "rankScores": {
    "total_score": 5000,
    "weekly_score": "$$__NULL__$$",
    "daily_score": "$$__NULL__$$"
  }
}
```

**Result:**
- Player's level updated
- Total score updated
- Weekly and daily scores removed (e.g., season ended)

## Important Notes

1. **Never Use Actual Null:** The system expects `"$$__NULL__$$"` as a string, not JavaScript/JSON `null`

2. **Validation:** The NULL_MARKER passes through InputValidator validation and is detected during sanitization

3. **Stream Consistency:** Keys marked with NULL_MARKER are excluded from stream updates, preventing downstream consumers from receiving deletion markers

4. **Atomic Operations:** All key removals are performed atomically alongside attribute updates

5. **Non-Existent Keys:** It's safe to mark a non-existent key for removal - the operation will simply do nothing for that key

6. **Case Sensitive:** The marker must be exactly `$$__NULL__$$` (case-sensitive)

## Security

The NULL_MARKER is validated through the InputValidator class, which ensures:
- Only valid attribute keys can be removed (alphanumeric + underscores)
- Maximum key length limits are enforced
- The marker itself cannot be used as a key name
- SQL injection protection remains intact

## Code References

- **NULL_MARKER Definition:** `util/InputValidator.js:5`
- **Ephemeral Processing:** `util/EphemeralEntityManager.js:66-107`
- **Persistent Processing:** `util/PersistentEntityManager.js:180-200`
- **Database Function:** `prisma/migrations/add_jsonb_functions.sql:66-97`
