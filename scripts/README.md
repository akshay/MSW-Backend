# Benchmark Script

Comprehensive benchmark and test suite for all CommandProcessor commands.

## Overview

This script tests and benchmarks all command types with realistic batch sizes:
- Entity CRUD operations (create, read, update, delete)
- Search by name queries
- Ranking queries (leaderboards)
- Entity rank calculations
- Stream operations (push and pull)

## Requirements

- Node.js with ES modules support
- Environment variables:
  - `SENDER_PUBLIC_KEY`: Base64-encoded public key for authentication
  - `RECIPIENT_PRIVATE_KEY`: Base64-encoded private key for decryption
  - `DATABASE_URL`: PostgreSQL/CockroachDB connection string
  - `REDIS_URL`: Redis connection string

## Usage

### Run the benchmark:
```bash
npm run benchmark
```

### Run with custom environment:
```bash
SENDER_PUBLIC_KEY=<key> RECIPIENT_PRIVATE_KEY=<key> npm run benchmark
```

## Test Configuration

Default configuration (configurable in `benchmark.js`):

```javascript
{
  entityTypes: ['player', 'guild', 'item', 'quest', 'achievement'],
  worldId: 1,

  // Batch sizes
  entitiesPerType: 1000,              // 5,000 total entities
  streamEventsPerEntity: 10,          // 10 events per entity
  entitiesPerStream: 100,             // 100 entities × 5 types × 10 events = 5,000 stream messages
  searchQueriesPerType: 10,           // 50 total searches
  rankCalculationsPerType: 10         // 50 total rank calculations
}
```

## Tests Performed

### 1. Create Entities (Test 1)
- Creates **5,000 entities** (1,000 per entity type)
- Tests `save_entity` with `isCreate: true`
- Validates entity creation
- Measures creation throughput

### 2. Load Entities (Test 2)
- Loads all **5,000 created entities**
- Tests `load_entity` command
- Validates all entities loaded successfully
- Measures read throughput

### 3. Update Entities (Test 3)
- Updates all **5,000 entities**
- Tests `save_entity` without operation flags (update)
- Changes attributes and rank scores
- Measures update throughput

### 4. Search by Name (Test 4)
- Executes **50 search queries** (10 per entity type)
- Tests `search_by_name` command
- Validates search results
- Measures search performance

### 5. Get Rankings (Test 5)
- Fetches rankings for **5 entity types**
- Tests `get_rankings` command (leaderboards)
- Returns top 100 entities per type
- Measures ranking query performance

### 6. Calculate Rank (Test 6)
- Calculates ranks for **50 entities** (10 per type)
- Tests `calculate_rank` command
- Validates rank positions returned
- Measures rank calculation performance

### 7. Add to Streams (Test 7)
- Adds **5,000 messages** to streams
  - 100 entities per type
  - 10 events per entity
  - 5 entity types
- Tests `add_to_stream` command
- Measures stream write throughput

### 8. Pull from Streams (Test 8)
- Pulls from **500 streams** (100 per entity type)
- Tests `pull_from_stream` command
- Validates messages retrieved
- Measures stream read throughput

### 9. Delete Entities (Test 9)
- Soft deletes all **5,000 entities**
- Tests `save_entity` with `isDelete: true`
- Validates deletion success
- Measures delete throughput

### 10. Verify Deleted Not Loaded (Test 10)
- Attempts to load **5,000 deleted entities**
- Tests soft delete functionality
- Validates all return `null` (not found)
- Confirms deleted entities are excluded

## Output

The benchmark provides:

### Test Results
```
✓ PASS Create entities 2341ms 5000/5000 created, 2136 ops/sec
✓ PASS Load entities 1823ms 5000/5000 loaded, 2743 ops/sec
✓ PASS Update entities 2156ms 5000/5000 updated, 2319 ops/sec
...
```

### Summary Statistics
```
BENCHMARK SUMMARY
========================================
Total Tests: 10
Passed: 10
Failed: 0
Pass Rate: 100.0%

Total Commands Executed: 20,550
Total Time: 15,234ms
Average Throughput: 1,349 commands/sec

Performance Breakdown:
  Create Entities           2341ms  (15.4%)
  Load Entities             1823ms  (12.0%)
  Update Entities           2156ms  (14.2%)
  Search by Name             234ms  (1.5%)
  Get Rankings               123ms  (0.8%)
  Calculate Rank             189ms  (1.2%)
  Add to Streams            3421ms  (22.5%)
  Pull from Streams         2134ms  (14.0%)
  Delete Entities           2289ms  (15.0%)
```

### Exit Codes
- `0`: All tests passed
- `1`: One or more tests failed

## Features

### Colored Output
- ✓ Green for passed tests
- ✗ Red for failed tests
- Yellow for timing information
- Cyan for section headers

### Performance Metrics
- Operations per second for each test
- Time breakdown by operation
- Total throughput across all commands
- Pass/fail status for each test

### Validation
- Verifies correct number of results
- Validates operation success
- Checks soft delete behavior
- Ensures data integrity

## Customization

Edit `BENCHMARK_CONFIG` in `benchmark.js` to adjust:
- Entity types to test
- Number of entities per type
- Stream message counts
- Query limits
- World ID

Example:
```javascript
const BENCHMARK_CONFIG = {
  entityTypes: ['player', 'monster'],  // Test only 2 types
  entitiesPerType: 500,                 // Create 500 of each
  streamEventsPerEntity: 5,             // 5 events per entity
  // ...
};
```

## Troubleshooting

### Connection Errors
Ensure database and Redis are running and accessible.

### Authentication Errors
Verify `SENDER_PUBLIC_KEY` and `RECIPIENT_PRIVATE_KEY` are correctly set.

### Timeout Errors
Reduce batch sizes in `BENCHMARK_CONFIG` for slower systems.

### Memory Issues
The benchmark creates 5,000 entities by default. Reduce `entitiesPerType` if memory is limited.

## Performance Expectations

Typical performance on modern hardware:
- **CRUD operations**: 2,000-3,000 ops/sec
- **Search queries**: 100-200 queries/sec (first run), 1,000+ (cached)
- **Rankings**: 50-100 queries/sec (first run), 500+ (cached)
- **Stream operations**: 1,500-2,500 msgs/sec
- **Overall throughput**: 1,000-1,500 commands/sec

Performance varies based on:
- Database and Redis performance
- Network latency
- System resources
- Cache hit rates

## Integration

This benchmark can be integrated into CI/CD pipelines:

```bash
# Run benchmark as part of CI
npm run benchmark || exit 1
```

Use exit code to fail builds if benchmarks don't pass.
