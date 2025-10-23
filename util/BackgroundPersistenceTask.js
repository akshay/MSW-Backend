// util/BackgroundPersistenceTask.js
import { ephemeralRedis } from '../config.js';
import { DistributedLock } from './DistributedLock.js';
import { metrics } from './MetricsCollector.js';

export class BackgroundPersistenceTask {
  constructor(ephemeralManager, persistentManager, options = {}) {
    this.ephemeralManager = ephemeralManager;
    this.persistentManager = persistentManager;
    this.lock = new DistributedLock(ephemeralRedis);

    // Configuration
    this.lockKey = options.lockKey || 'background:persistence:lock';
    this.lockTTL = options.lockTTL || 10; // 10 seconds
    this.batchSize = options.batchSize || 500; // Process 500 entities per run
    this.intervalMs = options.intervalMs || 5000; // Run every 5 seconds

    // State
    this.intervalId = null;
    this.isRunning = false;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      entitiesPersisted: 0,
      lastRunTime: null,
      lastError: null
    };
  }

  /**
   * Start the background persistence task
   */
  start() {
    if (this.isRunning) {
      console.log('Background persistence task is already running');
      return;
    }

    console.log(`Starting background persistence task (interval: ${this.intervalMs}ms, batch size: ${this.batchSize})`);
    this.isRunning = true;

    // Run immediately, then at intervals
    this.run();
    this.intervalId = setInterval(() => this.run(), this.intervalMs);
  }

  /**
   * Stop the background persistence task
   */
  stop() {
    if (!this.isRunning) {
      console.log('Background persistence task is not running');
      return;
    }

    console.log('Stopping background persistence task');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run one iteration of the persistence task
   */
  async run() {
    if (!this.isRunning) {
      return;
    }

    this.stats.totalRuns++;
    const startTime = Date.now();

    try {
      // Try to acquire distributed lock
      const result = await this.lock.withLock(
        this.lockKey,
        () => this.processPendingUpdates(),
        this.lockTTL
      );

      if (result === null) {
        // Could not acquire lock - another instance is running
        // This is not an error, just skip this run
        return;
      }

      this.stats.successfulRuns++;
      this.stats.lastRunTime = new Date().toISOString();

      const duration = Date.now() - startTime;

      // Record metrics
      metrics.recordBackgroundTaskRun(true, duration, result.processed);

      if (result.processed > 0) {
        console.log(
          `Background persistence: processed ${result.processed} entities in ${duration}ms ` +
          `(pending: ${result.remaining})`
        );
      }

    } catch (error) {
      this.stats.failedRuns++;
      this.stats.lastError = error.message;

      // Record failure metrics
      const duration = Date.now() - startTime;
      metrics.recordBackgroundTaskRun(false, duration, 0);

      console.error('Background persistence task failed:', error);
    }
  }

  /**
   * Process pending updates from ephemeral storage
   * This is called while holding the distributed lock
   */
  async processPendingUpdates() {
    // Get pending updates from ephemeral storage
    const pendingUpdates = await this.ephemeralManager.getPendingUpdates(this.batchSize);

    if (pendingUpdates.length === 0) {
      return { processed: 0, remaining: 0 };
    }

    // Persist to database using the direct persistence method
    // We bypass the ephemeral manager here since we're doing the background sync
    const results = await this.persistentManager.performBatchUpsert(
      this.convertToMergedUpdates(pendingUpdates)
    );

    // Count successful persists
    const successful = Array.from(results.values()).filter(r => r.success).length;

    // Flush successfully persisted entities from ephemeral storage
    const successfulKeys = pendingUpdates
      .filter((update, index) => {
        const key = `${update.entityType}:${update.entityId}:${update.worldId}`;
        const result = results.get(key);
        return result && result.success;
      })
      .map(({ entityType, entityId, worldId }) => ({ entityType, entityId, worldId }));

    await this.ephemeralManager.flushPersistedEntities(successfulKeys);

    // Update stats
    this.stats.entitiesPersisted += successful;

    // Get remaining count
    const remaining = await this.ephemeralManager.getPendingCount();

    return {
      processed: successful,
      remaining
    };
  }

  /**
   * Convert pending updates array to merged updates map format
   * expected by performBatchUpsert
   */
  convertToMergedUpdates(pendingUpdates) {
    const mergedUpdates = new Map();

    pendingUpdates.forEach(({ entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }) => {
      const key = `${entityType}:${entityId}:${worldId}`;
      const existing = mergedUpdates.get(key) || {
        entityType,
        entityId,
        worldId,
        attributes: {},
        rankScores: {},
        isCreate: false,
        isDelete: false
      };

      mergedUpdates.set(key, {
        ...existing,
        attributes: { ...existing.attributes, ...(attributes || {}) },
        rankScores: { ...existing.rankScores, ...(rankScores || {}) },
        isCreate: existing.isCreate || isCreate || false,
        isDelete: existing.isDelete || isDelete || false
      });
    });

    return mergedUpdates;
  }

  /**
   * Get statistics about the background task
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      entitiesPersisted: 0,
      lastRunTime: null,
      lastError: null
    };
  }
}
