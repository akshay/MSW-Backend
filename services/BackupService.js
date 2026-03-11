/**
 * Backup Service - Orchestrates all backup operations
 * Coordinates database backup, Redis backups, retention cleanup, and manifest updates
 */

const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const DatabaseBackup = require('./DatabaseBackup');
const RedisBackup = require('./RedisBackup');
const RetentionManager = require('./RetentionManager');
const BackupManifest = require('../util/BackupManifest');

// Redis clients
let cacheRedis = null;
let ephemeralRedis = null;
let streamRedis = null;

class BackupService {
  constructor() {
    this.dbBackup = new DatabaseBackup(config);
    this.redisBackup = new RedisBackup(config);
    this.retentionManager = new RetentionManager(config);
    this.manifest = null;
  }

  /**
   * Initialize Redis clients
   */
  async _initRedisClients() {
    if (!cacheRedis) {
      const Redis = require('ioredis');
      cacheRedis = new Redis(process.env.CACHE_REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
    }
    
    if (!ephemeralRedis) {
      const Redis = require('ioredis');
      ephemeralRedis = new Redis(process.env.EPHEMERAL_REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
    }
    
    if (!streamRedis) {
      const Redis = require('ioredis');
      streamRedis = new Redis(process.env.STREAM_REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
    }

    // Initialize manifest with cacheRedis
    if (!this.manifest) {
      this.manifest = new BackupManifest(cacheRedis);
    }
  }

  /**
   * Run a complete backup cycle
   * @returns {Object} Backup summary
   */
  async runBackup() {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[BackupService] Starting backup cycle at ${timestamp}`);
    console.log(`${'='.repeat(60)}\n`);

    const summary = {
      timestamp: timestamp,
      success: false,
      duration: 0,
      database: null,
      redis: {},
      totalSize: 0,
      retention: null
    };

    // Create timestamped temp directory
    const tempDir = path.join(
      config.backup.tempDir,
      timestamp.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    );

    try {
      // Initialize Redis clients
      await this._initRedisClients();

      // Ensure temp directory exists
      await fs.ensureDir(tempDir);
      console.log(`[BackupService] Using temp directory: ${tempDir}\n`);

      // Phase 1: Database Backup
      console.log(`[BackupService] Phase 1: Database Backup`);
      console.log('-'.repeat(60));
      try {
        summary.database = await this.dbBackup.create(tempDir);
        if (summary.database.success) {
          summary.totalSize += summary.database.size;
          console.log(`[BackupService] ✓ Database backup completed\n`);
        } else {
          console.error(`[BackupService] ✗ Database backup failed: ${summary.database.error}\n`);
        }
      } catch (error) {
        console.error(`[BackupService] Database backup error:`, error);
        summary.database = { success: false, error: error.message };
      }

      // Phase 2: Redis Backups (all 3 instances)
      console.log(`[BackupService] Phase 2: Redis Backups`);
      console.log('-'.repeat(60));
      
      const redisInstances = [
        { name: 'cache', client: cacheRedis },
        { name: 'ephemeral', client: ephemeralRedis },
        { name: 'stream', client: streamRedis }
      ];

      for (const instance of redisInstances) {
        console.log(`[BackupService] Backing up Redis: ${instance.name}`);
        try {
          const result = await this.redisBackup.create(instance.client, instance.name, tempDir);
          summary.redis[instance.name] = result;
          
          if (result.success) {
            summary.totalSize += result.size;
            console.log(`[BackupService] ✓ ${instance.name} backup completed\n`);
          } else {
            console.error(`[BackupService] ✗ ${instance.name} backup failed: ${result.error}\n`);
          }
        } catch (error) {
          console.error(`[BackupService] ${instance.name} backup error:`, error);
          summary.redis[instance.name] = { success: false, error: error.message };
        }
      }

      // Phase 3: Update Manifest
      console.log(`[BackupService] Phase 3: Update Manifest`);
      console.log('-'.repeat(60));
      try {
        await this.manifest.record(summary);
        console.log(`[BackupService] ✓ Manifest updated\n`);
      } catch (error) {
        console.error(`[BackupService] Manifest update failed:`, error);
      }

      // Phase 4: Retention Cleanup
      console.log(`[BackupService] Phase 4: Retention Cleanup`);
      console.log('-'.repeat(60));
      try {
        summary.retention = await this.retentionManager.cleanup();
        console.log(`[BackupService] ✓ Retention cleanup completed\n`);
      } catch (error) {
        console.error(`[BackupService] Retention cleanup failed:`, error);
        summary.retention = { deleted: 0, freedBytes: 0, errors: [error.message] };
      }

      // Determine overall success
      const dbSuccess = summary.database && summary.database.success;
      const redisSuccess = Object.values(summary.redis).some(r => r && r.success);
      summary.success = dbSuccess || redisSuccess;

    } catch (error) {
      console.error('[BackupService] Backup cycle failed:', error);
      summary.error = error.message;
    } finally {
      // Clean up temp directory
      try {
        await fs.remove(tempDir);
        console.log(`[BackupService] Cleaned up temp directory: ${tempDir}`);
      } catch (cleanupError) {
        console.error('[BackupService] Failed to clean up temp directory:', cleanupError);
      }

      summary.duration = Date.now() - startTime;
    }

    // Log final summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[BackupService] Backup Cycle Summary`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Timestamp:     ${summary.timestamp}`);
    console.log(`Duration:      ${summary.duration}ms (${(summary.duration / 1000).toFixed(2)}s)`);
    console.log(`Total Size:    ${(summary.totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Status:        ${summary.success ? '✓ SUCCESS' : '✗ PARTIAL/FAILED'}`);
    console.log(`Database:      ${summary.database?.success ? '✓' : '✗'}`);
    console.log(`Redis Cache:   ${summary.redis.cache?.success ? '✓' : '✗'}`);
    console.log(`Redis Eph:     ${summary.redis.ephemeral?.success ? '✓' : '✗'}`);
    console.log(`Redis Stream:  ${summary.redis.stream?.success ? '✓' : '✗'}`);
    if (summary.retention) {
      console.log(`Retention:     Deleted ${summary.retention.deleted} files, freed ${(summary.retention.freedBytes / 1024 / 1024).toFixed(2)} MB`);
    }
    console.log(`${'='.repeat(60)}\n`);

    return summary;
  }

  /**
   * Get backup statistics
   * @returns {Object} Stats object
   */
  async getStats() {
    try {
      await this._initRedisClients();
      
      const manifestStats = await this.manifest.getStats();
      const storageStats = await this.retentionManager.getStats();

      return {
        manifest: manifestStats,
        storage: storageStats
      };
    } catch (error) {
      console.error('[BackupService] Failed to get stats:', error);
      return null;
    }
  }

  /**
   * List recent backups
   * @param {number} limit - Maximum number to return
   * @returns {Array} Array of backup summaries
   */
  async listBackups(limit = 20) {
    try {
      await this._initRedisClients();
      return await this.manifest.list(limit);
    } catch (error) {
      console.error('[BackupService] Failed to list backups:', error);
      return [];
    }
  }

  /**
   * Get details of a specific backup
   * @param {string} timestamp - ISO timestamp
   * @returns {Object|null} Backup details
   */
  async getBackup(timestamp) {
    try {
      await this._initRedisClients();
      return await this.manifest.get(timestamp);
    } catch (error) {
      console.error('[BackupService] Failed to get backup:', error);
      return null;
    }
  }
}

// Export singleton instance
const backupService = new BackupService();

module.exports = backupService;
module.exports.BackupService = BackupService;
