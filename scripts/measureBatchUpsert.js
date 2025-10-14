// Performance measurement for performBatchUpsert
import { PersistentEntityManager } from '../util/PersistentEntityManager.js';
import { HybridCacheManager } from '../util/HybridCacheManager.js';
import { StreamManager } from '../util/StreamManager.js';
import { prisma } from '../config.js';

// Helper to generate test data
function generateTestUpdates(count, worldId = 1) {
  const updates = new Map();

  for (let i = 0; i < count; i++) {
    const key = `player:player_${i}:${worldId}`;
    updates.set(key, {
      entityType: 'player',
      entityId: `player_${i}`,
      worldId,
      attributes: {
        name: `Player ${i}`,
        level: Math.floor(Math.random() * 100),
        gold: Math.floor(Math.random() * 10000),
        experience: Math.floor(Math.random() * 50000)
      },
      rankScores: {
        score: Math.floor(Math.random() * 1000),
        kills: Math.floor(Math.random() * 100)
      },
      isCreate: false,
      isDelete: false
    });
  }

  return updates;
}

// Helper to measure execution time
async function measureTime(name, fn) {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  const duration = end - start;

  return { name, duration, result };
}

async function runPerformanceTests() {
  console.log('=== performBatchUpsert Performance Tests ===\n');

  // Initialize components
  const cacheManager = new HybridCacheManager();
  const streamManager = new StreamManager();
  const entityManager = new PersistentEntityManager(cacheManager, streamManager);

  const testSizes = [1000, 2000, 5000, 10000];
  const results = [];

  for (const size of testSizes) {
    console.log(`\n--- Testing with ${size} entities ---`);

    // Generate test data
    const updates = generateTestUpdates(size);

    // Measure total time including database operations
    const testResult = await measureTime(
      `Batch size: ${size}`,
      async () => {
        await entityManager.performBatchUpsert(updates);
        return { entitiesProcessed: size };
      }
    );

    const opsPerSecond = (size / (testResult.duration / 1000)).toFixed(2);
    const avgTimePerEntity = (testResult.duration / size).toFixed(3);

    console.log(`  Total time: ${testResult.duration.toFixed(2)}ms`);
    console.log(`  Avg per entity: ${avgTimePerEntity}ms`);
    console.log(`  Throughput: ${opsPerSecond} ops/sec`);

    results.push({
      batchSize: size,
      totalTime: testResult.duration,
      avgPerEntity: parseFloat(avgTimePerEntity),
      throughput: parseFloat(opsPerSecond)
    });

    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Summary
  console.log('\n=== Performance Summary ===\n');
  console.log('| Batch Size | Total Time (ms) | Avg/Entity (ms) | Throughput (ops/sec) |');
  console.log('|------------|----------------|-----------------|---------------------|');

  results.forEach(r => {
    console.log(
      `| ${r.batchSize.toString().padEnd(10)} | ${r.totalTime.toFixed(2).padEnd(14)} | ${r.avgPerEntity.toFixed(3).padEnd(15)} | ${r.throughput.toString().padEnd(19)} |`
    );
  });

  // Performance characteristics
  console.log('\n=== Analysis ===\n');

  const fastest = results.reduce((min, r) => r.avgPerEntity < min.avgPerEntity ? r : min);
  const slowest = results.reduce((max, r) => r.avgPerEntity > max.avgPerEntity ? r : max);
  const highestThroughput = results.reduce((max, r) => r.throughput > max.throughput ? r : max);

  console.log(`Most efficient batch size: ${fastest.batchSize} (${fastest.avgPerEntity}ms per entity)`);
  console.log(`Least efficient batch size: ${slowest.batchSize} (${slowest.avgPerEntity}ms per entity)`);
  console.log(`Highest throughput: ${highestThroughput.batchSize} entities (${highestThroughput.throughput} ops/sec)`);

  // Calculate scaling factor
  const smallBatch = results.find(r => r.batchSize === 10);
  const largeBatch = results.find(r => r.batchSize === 1000);

  if (smallBatch && largeBatch) {
    const scalingFactor = (largeBatch.avgPerEntity / smallBatch.avgPerEntity).toFixed(2);
    const speedup = (largeBatch.throughput / smallBatch.throughput).toFixed(2);
    console.log(`\nScaling characteristics (10 → 1000 entities):`);
    console.log(`  Per-entity time ratio: ${scalingFactor}x`);
    console.log(`  Throughput improvement: ${speedup}x`);
  }

  // Clean up
  await prisma.$disconnect();
}

// Run tests
runPerformanceTests()
  .then(() => {
    console.log('\n✓ Performance tests completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Performance test failed:', error);
    process.exit(1);
  });
