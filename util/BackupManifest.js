/**
 * Backup Manifest - Tracks backup metadata in Redis
 * Stores backup history and provides quick lookups for restore operations
 */

class BackupManifest {
  constructor(redisClient) {
    this.redis = redisClient;
    this.keyPrefix = 'backup:manifest';
    this.ttlSeconds = 8 * 24 * 60 * 60; // 8 days (slightly longer than retention)
  }

  /**
   * Record a backup in the manifest
   * @param {Object} summary - Backup summary from BackupService
   */
  async record(summary) {
    const timestamp = summary.timestamp;
    const key = `${this.keyPrefix}:${timestamp}`;
    const latestKey = `${this.keyPrefix}:latest`;

    try {
      // Store full backup metadata with TTL
      await this.redis.setex(key, this.ttlSeconds, JSON.stringify(summary));

      // Update latest pointer (no TTL)
      await this.redis.set(latestKey, timestamp);

      console.log(`[BackupManifest] Recorded backup: ${timestamp}`);
      return true;
    } catch (error) {
      console.error('[BackupManifest] Failed to record backup:', error);
      throw error;
    }
  }

  /**
   * Get the latest backup details
   * @returns {Object|null} Latest backup summary
   */
  async getLatest() {
    try {
      const latestKey = `${this.keyPrefix}:latest`;
      const latestTimestamp = await this.redis.get(latestKey);

      if (!latestTimestamp) {
        return null;
      }

      return await this.get(latestTimestamp);
    } catch (error) {
      console.error('[BackupManifest] Failed to get latest backup:', error);
      return null;
    }
  }

  /**
   * Get backup details for a specific timestamp
   * @param {string} timestamp - ISO timestamp
   * @returns {Object|null} Backup summary
   */
  async get(timestamp) {
    try {
      const key = `${this.keyPrefix}:${timestamp}`;
      const data = await this.redis.get(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      console.error(`[BackupManifest] Failed to get backup ${timestamp}:`, error);
      return null;
    }
  }

  /**
   * List recent backups
   * @param {number} limit - Maximum number of backups to return
   * @returns {Array} Array of backup summaries (latest first)
   */
  async list(limit = 20) {
    try {
      const pattern = `${this.keyPrefix}:*`;
      const keys = [];

      // Scan for all backup manifest keys
      let cursor = '0';
      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        const matchedKeys = result[1].filter(key => !key.endsWith(':latest'));
        keys.push(...matchedKeys);
      } while (cursor !== '0');

      // Sort by timestamp (descending - latest first)
      keys.sort((a, b) => {
        const tsA = a.split(':').pop();
        const tsB = b.split(':').pop();
        return tsB.localeCompare(tsA);
      });

      // Limit results
      const limitedKeys = keys.slice(0, limit);

      // Fetch backup data
      const backups = [];
      for (const key of limitedKeys) {
        const data = await this.redis.get(key);
        if (data) {
          backups.push(JSON.parse(data));
        }
      }

      return backups;
    } catch (error) {
      console.error('[BackupManifest] Failed to list backups:', error);
      return [];
    }
  }

  /**
   * Check if a backup exists
   * @param {string} timestamp - ISO timestamp
   * @returns {boolean}
   */
  async exists(timestamp) {
    try {
      const key = `${this.keyPrefix}:${timestamp}`;
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (error) {
      console.error(`[BackupManifest] Failed to check backup existence ${timestamp}:`, error);
      return false;
    }
  }

  /**
   * Delete a backup manifest entry
   * @param {string} timestamp - ISO timestamp
   * @returns {boolean}
   */
  async delete(timestamp) {
    try {
      const key = `${this.keyPrefix}:${timestamp}`;
      await this.redis.del(key);

      // If this was the latest backup, update the pointer
      const latestKey = `${this.keyPrefix}:latest`;
      const latestTimestamp = await this.redis.get(latestKey);

      if (latestTimestamp === timestamp) {
        // Find the new latest backup
        const backups = await this.list(1);
        if (backups.length > 0) {
          await this.redis.set(latestKey, backups[0].timestamp);
        } else {
          await this.redis.del(latestKey);
        }
      }

      console.log(`[BackupManifest] Deleted backup manifest: ${timestamp}`);
      return true;
    } catch (error) {
      console.error(`[BackupManifest] Failed to delete backup ${timestamp}:`, error);
      return false;
    }
  }

  /**
   * Get backup statistics
   * @returns {Object} Stats object
   */
  async getStats() {
    try {
      const backups = await this.list(100); // Get last 100 backups
      const latest = await this.getLatest();

      return {
        totalBackups: backups.length,
        latestBackup: latest ? latest.timestamp : null,
        latestStatus: latest ? (latest.success ? 'success' : 'partial') : null,
        totalSize: backups.reduce((sum, b) => sum + (b.totalSize || 0), 0)
      };
    } catch (error) {
      console.error('[BackupManifest] Failed to get stats:', error);
      return {
        totalBackups: 0,
        latestBackup: null,
        latestStatus: null,
        totalSize: 0
      };
    }
  }
}

module.exports = BackupManifest;
