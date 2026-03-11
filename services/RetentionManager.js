/**
 * Retention Manager - Deletes old backups from Backblaze B2
 * Enforces the configured retention policy (default: 7 days)
 */

const B2 = require('backblaze-b2');

class RetentionManager {
  constructor(config) {
    this.config = config;
    this.b2 = null;
  }

  /**
   * Initialize B2 client
   */
  async _initB2() {
    if (!this.b2) {
      this.b2 = new B2({
        applicationKeyId: process.env.BACKBLAZE_KEY_ID,
        applicationKey: process.env.BACKBLAZE_KEY
      });
      await this.b2.authorize();
    }
    return this.b2;
  }

  /**
   * Delete backups older than retention period
   * @returns {Object} { deleted: number, freedBytes: number, errors: [] }
   */
  async cleanup() {
    const startTime = Date.now();
    const retentionDays = this.config.backup.retentionDays || 7;
    const cutoffDate = new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000));
    
    console.log(`[RetentionManager] Starting cleanup, deleting backups older than ${retentionDays} days (before ${cutoffDate.toISOString()})`);

    const result = {
      deleted: 0,
      freedBytes: 0,
      errors: [],
      filesChecked: 0
    };

    try {
      await this._initB2();

      // Get bucket ID
      const bucketId = await this._getBucketId();
      
      if (!bucketId) {
        throw new Error(`Bucket not found: ${this.config.backup.b2Bucket}`);
      }

      // List all files in backups/ prefix
      let startFileName = null;
      let startFileId = null;
      let hasMore = true;

      while (hasMore) {
        const response = await this.b2.listFileVersions({
          bucketId: bucketId,
          prefix: 'backups/',
          startFileName: startFileName,
          startFileId: startFileId,
          maxFileCount: 100
        });

        const files = response.data.files || [];
        result.filesChecked += files.length;

        // Process each file
        for (const file of files) {
          try {
            const fileDate = new Date(file.uploadTimestamp);
            
            // Check if file is older than retention period
            if (fileDate < cutoffDate) {
              console.log(`[RetentionManager] Deleting old backup: ${file.fileName} (${fileDate.toISOString()})`);
              
              // Delete from B2
              await this.b2.deleteFileVersion({
                fileId: file.fileId,
                fileName: file.fileName
              });

              result.deleted++;
              result.freedBytes += file.contentLength || 0;
            }
          } catch (error) {
            console.error(`[RetentionManager] Failed to delete ${file.fileName}:`, error);
            result.errors.push({
              fileName: file.fileName,
              error: error.message
            });
          }
        }

        // Check if there are more files
        hasMore = response.data.nextFileId !== null;
        startFileName = response.data.nextFileName;
        startFileId = response.data.nextFileId;
      }

      const duration = Date.now() - startTime;
      console.log(`[RetentionManager] Cleanup completed in ${duration}ms. Deleted ${result.deleted} files, freed ${(result.freedBytes / 1024 / 1024).toFixed(2)} MB`);

      return result;
    } catch (error) {
      console.error('[RetentionManager] Cleanup failed:', error);
      result.errors.push({
        error: error.message
      });
      return result;
    }
  }

  /**
   * Get bucket ID from bucket name
   * @returns {string|null} Bucket ID
   */
  async _getBucketId() {
    try {
      const response = await this.b2.listBuckets();
      const bucket = response.data.buckets.find(b => b.bucketName === this.config.backup.b2Bucket);
      return bucket ? bucket.bucketId : null;
    } catch (error) {
      console.error('[RetentionManager] Failed to list buckets:', error);
      return null;
    }
  }

  /**
   * Get storage statistics
   * @returns {Object} { totalFiles, totalBytes, oldestBackup, newestBackup }
   */
  async getStats() {
    try {
      await this._initB2();

      const bucketId = await this._getBucketId();
      
      if (!bucketId) {
        throw new Error(`Bucket not found: ${this.config.backup.b2Bucket}`);
      }

      const stats = {
        totalFiles: 0,
        totalBytes: 0,
        oldestBackup: null,
        newestBackup: null,
        byType: {
          db: { count: 0, bytes: 0 },
          redis: { count: 0, bytes: 0 }
        }
      };

      let startFileName = null;
      let startFileId = null;
      let hasMore = true;

      while (hasMore) {
        const response = await this.b2.listFileVersions({
          bucketId: bucketId,
          prefix: 'backups/',
          startFileName: startFileName,
          startFileId: startFileId,
          maxFileCount: 100
        });

        const files = response.data.files || [];

        for (const file of files) {
          stats.totalFiles++;
          stats.totalBytes += file.contentLength || 0;

          const fileDate = new Date(file.uploadTimestamp);
          
          if (!stats.oldestBackup || fileDate < new Date(stats.oldestBackup)) {
            stats.oldestBackup = fileDate.toISOString();
          }
          
          if (!stats.newestBackup || fileDate > new Date(stats.newestBackup)) {
            stats.newestBackup = fileDate.toISOString();
          }

          // Categorize by type
          if (file.fileName.includes('/db/')) {
            stats.byType.db.count++;
            stats.byType.db.bytes += file.contentLength || 0;
          } else if (file.fileName.includes('/redis/')) {
            stats.byType.redis.count++;
            stats.byType.redis.bytes += file.contentLength || 0;
          }
        }

        hasMore = response.data.nextFileId !== null;
        startFileName = response.data.nextFileName;
        startFileId = response.data.nextFileId;
      }

      return stats;
    } catch (error) {
      console.error('[RetentionManager] Failed to get stats:', error);
      return null;
    }
  }

  /**
   * Delete a specific backup by timestamp
   * @param {string} timestamp - ISO timestamp of backup to delete
   * @returns {Object} { success, deletedFiles, freedBytes }
   */
  async deleteBackupByTimestamp(timestamp) {
    console.log(`[RetentionManager] Deleting backup: ${timestamp}`);

    const result = {
      success: false,
      deletedFiles: 0,
      freedBytes: 0
    };

    try {
      await this._initB2();

      const bucketId = await this._getBucketId();
      
      if (!bucketId) {
        throw new Error(`Bucket not found: ${this.config.backup.b2Bucket}`);
      }

      // List all files and find ones matching timestamp
      const response = await this.b2.listFileVersions({
        bucketId: bucketId,
        prefix: 'backups/',
        maxFileCount: 1000
      });

      const files = response.data.files || [];
      
      // Find files matching the timestamp
      const matchingFiles = files.filter(file => {
        const fileName = file.fileName;
        return fileName.includes(timestamp.replace(/[:.]/g, '-').replace('T', '_').replace('Z', ''));
      });

      // Delete matching files
      for (const file of matchingFiles) {
        await this.b2.deleteFileVersion({
          fileId: file.fileId,
          fileName: file.fileName
        });

        result.deletedFiles++;
        result.freedBytes += file.contentLength || 0;
        console.log(`[RetentionManager] Deleted: ${file.fileName}`);
      }

      result.success = true;
      return result;
    } catch (error) {
      console.error(`[RetentionManager] Failed to delete backup ${timestamp}:`, error);
      return result;
    }
  }
}

module.exports = RetentionManager;
