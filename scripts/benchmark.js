#!/usr/bin/env node
// scripts/benchmark.js - Comprehensive benchmark and test suite for all commands

import 'dotenv/config';
import nacl from 'tweetnacl';
import { CommandProcessor } from '../util/CommandProcessor.js';

// Benchmark configuration
const BENCHMARK_CONFIG = {
  entityTypes: ['player', 'guild', 'item', 'quest', 'achievement'],
  worldId: 1,
  worldInstanceId: 'benchmark-world-1',

  // Batch sizes
  entitiesPerType: 1000,
  streamEventsPerEntity: 10,
  entitiesPerStream: 100,
  rankingQueries: 5,
  searchQueriesPerType: 10,
  rankCalculationsPerType: 10
};

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m'
};

class BenchmarkRunner {
  constructor() {
    this.processor = new CommandProcessor();
    this.results = {
      tests: [],
      timings: {},
      totalCommands: 0,
      totalTime: 0
    };
    this.createdEntities = new Map(); // Track created entities for cleanup
  }

  log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
  }

  logSection(title) {
    console.log('\n' + '='.repeat(80));
    this.log(title, colors.bright + colors.cyan);
    console.log('='.repeat(80) + '\n');
  }

  logTest(name, passed, duration, details = '') {
    const status = passed ? `${colors.green}✓ PASS` : `${colors.red}✗ FAIL`;
    const time = `${colors.yellow}${duration}ms`;
    this.log(`${status}${colors.reset} ${name} ${time}${colors.reset} ${details}`);

    this.results.tests.push({ name, passed, duration, details });
  }

  // Generate encryption parameters for auth
  async generateAuthParams() {
    // Generate a nonce with sequence number, random, and elapsed time
    const nonce = new Uint8Array(24);
    const sequenceNumber = Date.now(); // Use timestamp as sequence
    const randomNumber = Math.floor(Math.random() * 1000000);
    const elapsedSeconds = Math.floor(Date.now() / 1000);

    // Write little-endian uint64 values
    this.writeLittleEndianUint64(nonce, 0, sequenceNumber);
    this.writeLittleEndianUint64(nonce, 8, randomNumber);
    this.writeLittleEndianUint64(nonce, 16, elapsedSeconds);

    // Encrypt worldInstanceId
    const message = nacl.util.decodeUTF8(BENCHMARK_CONFIG.worldInstanceId);
    const senderPublicKey = nacl.util.decodeBase64(process.env.SENDER_PUBLIC_KEY);
    const recipientPrivateKey = nacl.util.decodeBase64(process.env.RECIPIENT_PRIVATE_KEY);

    const encrypted = nacl.box(message, nonce, senderPublicKey, recipientPrivateKey);
    const encryptedString = nacl.util.encodeUTF8(encrypted).slice(0, 24);

    return {
      encrypted: encryptedString,
      nonce: nacl.util.encodeBase64(nonce),
      auth: process.env.SENDER_PUBLIC_KEY,
      worldInstanceId: BENCHMARK_CONFIG.worldInstanceId
    };
  }

  writeLittleEndianUint64(buffer, offset, value) {
    for (let i = 0; i < 8; i++) {
      buffer[offset + i] = value % 256;
      value = Math.floor(value / 256);
    }
  }

  async executeCommands(commands, description) {
    const authParams = await this.generateAuthParams();
    const payload = {
      ...authParams,
      commands
    };

    const startTime = performance.now();
    let results;
    let error = null;

    try {
      results = await this.processor.processCommands(payload);
    } catch (err) {
      error = err;
    }

    const duration = Math.round(performance.now() - startTime);

    this.results.totalCommands += commands.length;
    this.results.totalTime += duration;

    return { results, duration, error };
  }

  // Test 1: Create entities
  async testCreateEntities() {
    this.logSection('TEST 1: Create Entities');

    const totalEntities = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.entitiesPerType;
    this.log(`Creating ${totalEntities} entities (${BENCHMARK_CONFIG.entitiesPerType} per type)...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      for (let i = 0; i < BENCHMARK_CONFIG.entitiesPerType; i++) {
        const entityId = `${entityType}-${i}`;
        commands.push({
          type: 'save_entity',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId,
          attributes: {
            name: `${entityType}_${i}`,
            level: Math.floor(Math.random() * 100) + 1,
            created_at: Date.now()
          },
          rank_score: Math.random() * 10000,
          isCreate: true
        });

        // Track created entity
        if (!this.createdEntities.has(entityType)) {
          this.createdEntities.set(entityType, []);
        }
        this.createdEntities.get(entityType).push(entityId);
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'create entities');

    if (error) {
      this.logTest('Create entities', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => r && r.success !== false).length;
    const passed = successCount === totalEntities;

    this.logTest(
      'Create entities',
      passed,
      duration,
      `${successCount}/${totalEntities} created, ${(totalEntities / duration * 1000).toFixed(0)} ops/sec`
    );

    this.results.timings.create = duration;
    return passed;
  }

  // Test 2: Load entities
  async testLoadEntities() {
    this.logSection('TEST 2: Load Entities');

    const totalEntities = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.entitiesPerType;
    this.log(`Loading ${totalEntities} entities...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (const entityId of entities) {
        commands.push({
          type: 'load_entity',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'load entities');

    if (error) {
      this.logTest('Load entities', false, duration, error.message);
      return false;
    }

    const loadedCount = results.filter(r => r !== null && r !== undefined).length;
    const passed = loadedCount === totalEntities;

    this.logTest(
      'Load entities',
      passed,
      duration,
      `${loadedCount}/${totalEntities} loaded, ${(totalEntities / duration * 1000).toFixed(0)} ops/sec`
    );

    this.results.timings.load = duration;
    return passed;
  }

  // Test 3: Update entities
  async testUpdateEntities() {
    this.logSection('TEST 3: Update Entities');

    const totalEntities = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.entitiesPerType;
    this.log(`Updating ${totalEntities} entities...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (const entityId of entities) {
        commands.push({
          type: 'save_entity',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId,
          attributes: {
            level: Math.floor(Math.random() * 100) + 1,
            updated_at: Date.now()
          },
          rank_score: Math.random() * 10000
          // No isCreate or isDelete = update
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'update entities');

    if (error) {
      this.logTest('Update entities', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => r && r.success !== false).length;
    const passed = successCount === totalEntities;

    this.logTest(
      'Update entities',
      passed,
      duration,
      `${successCount}/${totalEntities} updated, ${(totalEntities / duration * 1000).toFixed(0)} ops/sec`
    );

    this.results.timings.update = duration;
    return passed;
  }

  // Test 4: Search entities by name
  async testSearchByName() {
    this.logSection('TEST 4: Search Entities by Name');

    const totalSearches = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.searchQueriesPerType;
    this.log(`Executing ${totalSearches} search queries...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      for (let i = 0; i < BENCHMARK_CONFIG.searchQueriesPerType; i++) {
        commands.push({
          type: 'search_by_name',
          entityType,
          namePattern: `${entityType}_${i}`,
          worldId: BENCHMARK_CONFIG.worldId,
          limit: 100
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'search by name');

    if (error) {
      this.logTest('Search by name', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => Array.isArray(r)).length;
    const totalResults = results.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
    const passed = successCount === totalSearches;

    this.logTest(
      'Search by name',
      passed,
      duration,
      `${successCount}/${totalSearches} queries, ${totalResults} results found, ${(totalSearches / duration * 1000).toFixed(0)} queries/sec`
    );

    this.results.timings.search = duration;
    return passed;
  }

  // Test 5: Get rankings
  async testGetRankings() {
    this.logSection('TEST 5: Get Rankings (Leaderboards)');

    const totalQueries = BENCHMARK_CONFIG.entityTypes.length;
    this.log(`Fetching rankings for ${totalQueries} entity types...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      commands.push({
        type: 'get_rankings',
        entityType,
        worldId: BENCHMARK_CONFIG.worldId,
        rankKey: 'rank_score',
        sortOrder: 'DESC',
        limit: 100
      });
    }

    const { results, duration, error } = await this.executeCommands(commands, 'get rankings');

    if (error) {
      this.logTest('Get rankings', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => Array.isArray(r)).length;
    const totalResults = results.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
    const passed = successCount === totalQueries;

    this.logTest(
      'Get rankings',
      passed,
      duration,
      `${successCount}/${totalQueries} queries, ${totalResults} ranked entities, ${(totalQueries / duration * 1000).toFixed(0)} queries/sec`
    );

    this.results.timings.rankings = duration;
    return passed;
  }

  // Test 6: Calculate entity ranks
  async testCalculateRank() {
    this.logSection('TEST 6: Calculate Entity Ranks');

    const totalCalculations = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.rankCalculationsPerType;
    this.log(`Calculating ranks for ${totalCalculations} entities...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (let i = 0; i < Math.min(BENCHMARK_CONFIG.rankCalculationsPerType, entities.length); i++) {
        commands.push({
          type: 'calculate_rank',
          entityType,
          entityId: entities[i],
          worldId: BENCHMARK_CONFIG.worldId,
          rankKey: 'rank_score'
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'calculate rank');

    if (error) {
      this.logTest('Calculate rank', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => r && r.rank !== null && r.rank !== undefined).length;
    const passed = successCount === totalCalculations;

    this.logTest(
      'Calculate rank',
      passed,
      duration,
      `${successCount}/${totalCalculations} calculated, ${(totalCalculations / duration * 1000).toFixed(0)} ops/sec`
    );

    this.results.timings.calculateRank = duration;
    return passed;
  }

  // Test 7: Add to streams
  async testAddToStreams() {
    this.logSection('TEST 7: Add Messages to Streams');

    const entitiesPerType = Math.min(BENCHMARK_CONFIG.entitiesPerStream, BENCHMARK_CONFIG.entitiesPerType);
    const totalMessages = BENCHMARK_CONFIG.entityTypes.length * entitiesPerType * BENCHMARK_CONFIG.streamEventsPerEntity;

    this.log(`Adding ${totalMessages} messages to streams (${BENCHMARK_CONFIG.streamEventsPerEntity} events × ${entitiesPerType} entities × ${BENCHMARK_CONFIG.entityTypes.length} types)...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (let i = 0; i < entitiesPerType; i++) {
        const entityId = entities[i];
        const streamId = `entity:${entityType}:${BENCHMARK_CONFIG.worldId}:${entityId}`;

        for (let j = 0; j < BENCHMARK_CONFIG.streamEventsPerEntity; j++) {
          commands.push({
            type: 'add_to_stream',
            entityType,
            entityId,
            worldId: BENCHMARK_CONFIG.worldId,
            streamId,
            message: {
              event: `event_${j}`,
              timestamp: Date.now(),
              data: { value: Math.random() }
            }
          });
        }
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'add to streams');

    if (error) {
      this.logTest('Add to streams', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => r && r.success !== false).length;
    const passed = successCount === totalMessages;

    this.logTest(
      'Add to streams',
      passed,
      duration,
      `${successCount}/${totalMessages} added, ${(totalMessages / duration * 1000).toFixed(0)} msgs/sec`
    );

    this.results.timings.streamAdd = duration;
    return passed;
  }

  // Test 8: Pull from streams
  async testPullFromStreams() {
    this.logSection('TEST 8: Pull Messages from Streams');

    const entitiesPerType = Math.min(BENCHMARK_CONFIG.entitiesPerStream, BENCHMARK_CONFIG.entitiesPerType);
    const totalPulls = BENCHMARK_CONFIG.entityTypes.length * entitiesPerType;

    this.log(`Pulling from ${totalPulls} streams...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (let i = 0; i < entitiesPerType; i++) {
        const entityId = entities[i];
        const streamId = `entity:${entityType}:${BENCHMARK_CONFIG.worldId}:${entityId}`;

        commands.push({
          type: 'pull_from_stream',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId,
          streamId,
          count: BENCHMARK_CONFIG.streamEventsPerEntity
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'pull from streams');

    if (error) {
      this.logTest('Pull from streams', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => Array.isArray(r)).length;
    const totalMessages = results.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
    const passed = successCount === totalPulls;

    this.logTest(
      'Pull from streams',
      passed,
      duration,
      `${successCount}/${totalPulls} pulls, ${totalMessages} messages retrieved, ${(totalPulls / duration * 1000).toFixed(0)} pulls/sec`
    );

    this.results.timings.streamPull = duration;
    return passed;
  }

  // Test 9: Delete entities
  async testDeleteEntities() {
    this.logSection('TEST 9: Delete Entities (Soft Delete)');

    const totalEntities = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.entitiesPerType;
    this.log(`Deleting ${totalEntities} entities...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (const entityId of entities) {
        commands.push({
          type: 'save_entity',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId,
          attributes: {},
          isDelete: true
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'delete entities');

    if (error) {
      this.logTest('Delete entities', false, duration, error.message);
      return false;
    }

    const successCount = results.filter(r => r && r.success !== false).length;
    const passed = successCount === totalEntities;

    this.logTest(
      'Delete entities',
      passed,
      duration,
      `${successCount}/${totalEntities} deleted, ${(totalEntities / duration * 1000).toFixed(0)} ops/sec`
    );

    this.results.timings.delete = duration;
    return passed;
  }

  // Test 10: Verify deleted entities don't appear
  async testVerifyDeletedNotLoaded() {
    this.logSection('TEST 10: Verify Deleted Entities Are Not Loaded');

    const totalEntities = BENCHMARK_CONFIG.entityTypes.length * BENCHMARK_CONFIG.entitiesPerType;
    this.log(`Attempting to load ${totalEntities} deleted entities...`, colors.cyan);

    const commands = [];

    for (const entityType of BENCHMARK_CONFIG.entityTypes) {
      const entities = this.createdEntities.get(entityType) || [];
      for (const entityId of entities) {
        commands.push({
          type: 'load_entity',
          entityType,
          entityId,
          worldId: BENCHMARK_CONFIG.worldId
        });
      }
    }

    const { results, duration, error } = await this.executeCommands(commands, 'load deleted entities');

    if (error) {
      this.logTest('Verify deleted not loaded', false, duration, error.message);
      return false;
    }

    const nullCount = results.filter(r => r === null || r === undefined).length;
    const passed = nullCount === totalEntities;

    this.logTest(
      'Verify deleted not loaded',
      passed,
      duration,
      `${nullCount}/${totalEntities} returned null (correct)`
    );

    return passed;
  }

  // Print final summary
  printSummary() {
    this.logSection('BENCHMARK SUMMARY');

    const passedTests = this.results.tests.filter(t => t.passed).length;
    const totalTests = this.results.tests.length;
    const passRate = ((passedTests / totalTests) * 100).toFixed(1);

    this.log(`Total Tests: ${totalTests}`, colors.bright);
    this.log(`Passed: ${colors.green}${passedTests}${colors.reset}`);
    this.log(`Failed: ${colors.red}${totalTests - passedTests}${colors.reset}`);
    this.log(`Pass Rate: ${passRate}%`, colors.bright);
    this.log(`\nTotal Commands Executed: ${this.results.totalCommands.toLocaleString()}`, colors.cyan);
    this.log(`Total Time: ${this.results.totalTime.toLocaleString()}ms`, colors.cyan);
    this.log(`Average Throughput: ${(this.results.totalCommands / this.results.totalTime * 1000).toFixed(0)} commands/sec`, colors.bright + colors.yellow);

    console.log('\n' + '-'.repeat(80));
    this.log('Performance Breakdown:', colors.bright);
    console.log('-'.repeat(80));

    const operations = [
      { name: 'Create Entities', key: 'create' },
      { name: 'Load Entities', key: 'load' },
      { name: 'Update Entities', key: 'update' },
      { name: 'Search by Name', key: 'search' },
      { name: 'Get Rankings', key: 'rankings' },
      { name: 'Calculate Rank', key: 'calculateRank' },
      { name: 'Add to Streams', key: 'streamAdd' },
      { name: 'Pull from Streams', key: 'streamPull' },
      { name: 'Delete Entities', key: 'delete' }
    ];

    for (const op of operations) {
      const time = this.results.timings[op.key];
      if (time !== undefined) {
        const percent = ((time / this.results.totalTime) * 100).toFixed(1);
        this.log(`  ${op.name.padEnd(25)} ${String(time).padStart(8)}ms  (${percent}%)`, colors.yellow);
      }
    }

    console.log('\n' + '='.repeat(80));

    if (passedTests === totalTests) {
      this.log('✓ ALL TESTS PASSED!', colors.bright + colors.green);
    } else {
      this.log('✗ SOME TESTS FAILED', colors.bright + colors.red);

      console.log('\nFailed Tests:');
      this.results.tests.filter(t => !t.passed).forEach(t => {
        this.log(`  - ${t.name}: ${t.details}`, colors.red);
      });
    }

    console.log('='.repeat(80) + '\n');
  }

  async run() {
    this.log('\n' + '█'.repeat(80), colors.bright + colors.blue);
    this.log('COMPREHENSIVE BENCHMARK & TEST SUITE', colors.bright + colors.blue);
    this.log('█'.repeat(80) + '\n', colors.bright + colors.blue);

    this.log(`Configuration:`, colors.cyan);
    this.log(`  Entity Types: ${BENCHMARK_CONFIG.entityTypes.join(', ')}`);
    this.log(`  Entities per Type: ${BENCHMARK_CONFIG.entitiesPerType.toLocaleString()}`);
    this.log(`  Stream Events per Entity: ${BENCHMARK_CONFIG.streamEventsPerEntity}`);
    this.log(`  Entities for Streams: ${BENCHMARK_CONFIG.entitiesPerStream}`);
    this.log(`  Search Queries per Type: ${BENCHMARK_CONFIG.searchQueriesPerType}`);
    this.log(`  Rank Calculations per Type: ${BENCHMARK_CONFIG.rankCalculationsPerType}`);
    this.log(`  World ID: ${BENCHMARK_CONFIG.worldId}\n`);

    const startTime = performance.now();

    // Run all tests in sequence
    await this.testCreateEntities();
    await this.testLoadEntities();
    await this.testUpdateEntities();
    await this.testSearchByName();
    await this.testGetRankings();
    await this.testCalculateRank();
    await this.testAddToStreams();
    await this.testPullFromStreams();
    await this.testDeleteEntities();
    await this.testVerifyDeletedNotLoaded();

    const totalDuration = Math.round(performance.now() - startTime);
    this.results.totalTime = totalDuration;

    this.printSummary();

    // Exit with appropriate code
    const allPassed = this.results.tests.every(t => t.passed);
    process.exit(allPassed ? 0 : 1);
  }
}

// Main execution
async function main() {
  // Verify environment variables
  if (!process.env.SENDER_PUBLIC_KEY || !process.env.RECIPIENT_PRIVATE_KEY) {
    console.error('ERROR: SENDER_PUBLIC_KEY and RECIPIENT_PRIVATE_KEY environment variables are required');
    process.exit(1);
  }

  const runner = new BenchmarkRunner();
  await runner.run();
}

main().catch(error => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
