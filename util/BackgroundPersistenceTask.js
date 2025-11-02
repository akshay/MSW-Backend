// util/BackgroundPersistenceTask.js
import { ephemeralRedis, config } from '../config.js';
import { DistributedLock } from './DistributedLock.js';
import { metrics } from './MetricsCollector.js';

export class BackgroundPersistenceTask {
  constructor(ephemeralManager, persistentManager, options = {}) {
    this.ephemeralManager = ephemeralManager;
    this.persistentManager = persistentManager;
    this.lock = new DistributedLock(ephemeralRedis);

    // Configuration with environment variable defaults
    this.lockKey = options.lockKey || 'background:persistence:lock';
    this.lockTTL = options.lockTTL || config.backgroundPersistence.lockTTL;
    this.batchSize = options.batchSize || config.backgroundPersistence.batchSize;
    this.intervalMs = options.intervalMs || config.backgroundPersistence.intervalMs;
    this.maxRetries = options.maxRetries || config.backgroundPersistence.maxRetries;
    this.retryDelayMs = options.retryDelayMs || config.backgroundPersistence.retryDelayMs;

    // State
    this.intervalId = null;
    this.isRunning = false;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      entitiesPersisted: 0,
      retriedOperations: 0,
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
   * Process pending updates from ephemeral storage with retry logic
   * This is called while holding the distributed lock
   */
  async processPendingUpdates() {
    // Get pending updates from ephemeral storage
    const originalUpdates = await this.ephemeralManager.getPendingUpdates(this.batchSize);

    if (originalUpdates.length === 0) {
      return { processed: 0, remaining: 0 };
    }

    // Track all results across retries and remaining updates to retry
    const allResults = new Map();
    let pendingUpdates = originalUpdates;
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Persist to database using the direct persistence method
        const results = await this.persistentManager.performBatchUpsert(
          this.convertToMergedUpdates(pendingUpdates)
        );

        // Merge results into allResults map, handling non-retryable errors
        for (const [key, result] of results.entries()) {
          // Convert non-retryable errors to success
          if (!result.success && result.error === 'ENTITY_NOT_FOUND') {
            console.log(`Entity not found during persistence (likely deleted): ${key} - marking as success`);
            allResults.set(key, { success: true, version: 0, skipped: true });
          } else {
            allResults.set(key, result);
          }
        }

        // Check if any operations failed (excluding non-retryable errors already converted to success)
        const failed = Array.from(allResults.values()).filter(r => !r.success);

        if (failed.length === 0) {
          // All succeeded, break out of retry loop
          break;
        }

        // Some operations failed - filter to retry only retryable failures
        if (attempt < this.maxRetries) {
          const retryableFailedKeys = Array.from(allResults.entries())
            .filter(([, result]) => !result.success && result.error !== 'ENTITY_NOT_FOUND')
            .map(([key]) => key);

          // Filter pendingUpdates to only include retryable failed operations
          pendingUpdates = pendingUpdates.filter(update => {
            const key = `${update.entityType}:${update.entityId}:${update.worldId}`;
            return retryableFailedKeys.includes(key);
          });

          if (pendingUpdates.length > 0) {
            console.warn(
              `Batch persistence partially failed (${failed.length} failures), ` +
              `retrying ${pendingUpdates.length} retryable operations in ${this.retryDelayMs}ms ` +
              `(attempt ${attempt}/${this.maxRetries})`
            );
            this.stats.retriedOperations += pendingUpdates.length;
            await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
          } else {
            // No retryable failures left
            break;
          }
        } else {
          console.error(`Batch persistence failed after ${this.maxRetries} attempts for ${failed.length} entities:`, failed);
        }

      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          console.warn(
            `Batch persistence error, retrying ${pendingUpdates.length} operations in ${this.retryDelayMs}ms ` +
            `(attempt ${attempt}/${this.maxRetries}):`, error
          );
          this.stats.retriedOperations += pendingUpdates.length;
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
        } else {
          console.error(`Batch persistence failed after ${this.maxRetries} attempts:`, error);
          throw error; // Re-throw on final attempt
        }
      }
    }

    if (allResults.size === 0) {
      throw new Error(`Failed to persist batch after ${this.maxRetries} attempts: ${lastError}`);
    }

    // Count successful persists
    const successful = Array.from(allResults.values()).filter(r => r.success).length;

    // Flush successfully persisted entities from ephemeral storage and remove from dirty set
    // Use originalUpdates to get all attempted entities, not just the failed ones from retries
    const successfulKeys = originalUpdates
      .filter((update) => {
        const key = `${update.entityType}:${update.entityId}:${update.worldId}`;
        const result = allResults.get(key);
        return result && result.success;
      })
      .map(({ environment, entityType, entityId, worldId, dirtyKey }) => {
        const key = `${entityType}:${entityId}:${worldId}`;
        const result = allResults.get(key);
        return {
          environment,
          entityType,
          entityId,
          worldId,
          dirtyKey,
          persistedVersion: result.version // Include persisted version for race condition check
        };
      });

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

    pendingUpdates.forEach(({ environment, entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }) => {
      const key = `${entityType}:${entityId}:${worldId}`;
      const existing = mergedUpdates.get(key) || {
        environment,
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
