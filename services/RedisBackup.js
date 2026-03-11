/**
 * Redis Backup - Creates RDB snapshots for Redis instances using BGSAVE
 * Supports backing up multiple Redis instances sequentially
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const BackblazeFileManager = require('../util/BackblazeFileManager');

class RedisBackup {
  constructor(config) {
    this.config = config;
    this.maxWaitSeconds = 60; // Max time to wait for BGSAVE to complete
  }

  /**
   * Create backup for a single Redis instance
   * @param {Object} redisClient - ioredis client instance
   * @param {string} instanceName - Name of the Redis instance (cache, ephemeral, stream)
   * @param {string} tempDir - Temporary directory for backup files
   * @returns {Object} Backup result { b2FileId, size, checksum, duration }
   */
  async create(redisClient, instanceName, tempDir) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const backupFileName = `${timestamp}.rdb.gz`;
    const backupFilePath = path.join(tempDir, instanceName, backupFileName);
    const b2Path = `backups/redis/${instanceName}/${backupFileName}`;

    console.log(`[RedisBackup] Starting backup for ${instanceName}: ${backupFileName}`);

    try {
      // Ensure temp directory exists
      await fs.ensureDir(path.join(tempDir, instanceName));

      // Get RDB file location from Redis config
      const rdbInfo = await this._getRDBLocation(redisClient);
      const rdbPath = path.join(rdbInfo.dir, rdbInfo.dbfilename);

      console.log(`[RedisBackup] RDB location for ${instanceName}: ${rdbPath}`);

      // Trigger BGSAVE (non-blocking)
      const bgsaveStarted = await this._triggerBGSAVE(redisClient);
      
      if (!bgsaveStarted) {
        throw new Error('Failed to start BGSAVE');
      }

      // Wait for BGSAVE to complete
      const saveComplete = await this._waitForBGSAVE(redisClient);
      
      if (!saveComplete) {
        throw new Error('BGSAVE did not complete within timeout');
      }

      // Copy RDB file to temp directory
      const tempRdbPath = path.join(tempDir, instanceName, `${timestamp}.rdb`);
      await fs.copy(rdbPath, tempRdbPath);

      // Compress RDB file with gzip
      const { size, checksum } = await this._compressFile(tempRdbPath, backupFilePath);

      // Delete uncompressed temp RDB
      await fs.remove(tempRdbPath);

      // Upload to B2
      console.log(`[RedisBackup] Uploading ${instanceName} to B2: ${b2Path}`);
      const fileManager = new BackblazeFileManager();
      await fileManager.ensureAuthorized();

      const uploadResult = await fileManager.uploadFile(
        backupFilePath,
        b2Path,
        this.config.backup.b2Bucket
      );

      // Delete local temp file immediately
      await fs.remove(backupFilePath);

      const duration = Date.now() - startTime;
      console.log(`[RedisBackup] ${instanceName} completed in ${duration}ms, size: ${size} bytes`);

      return {
        success: true,
        instance: instanceName,
        b2FileId: uploadResult.fileId,
        size: size,
        checksum: `sha256:${checksum}`,
        duration: duration,
        b2Path: b2Path
      };
    } catch (error) {
      console.error(`[RedisBackup] ${instanceName} backup failed:`, error);

      // Clean up temp files
      try {
        await fs.remove(backupFilePath);
        await fs.remove(path.join(tempDir, instanceName, `${timestamp}.rdb`));
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      return {
        success: false,
        instance: instanceName,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Get RDB file location from Redis config
   * @param {Object} redisClient - ioredis client
   * @returns {Object} { dir, dbfilename }
   */
  async _getRDBLocation(redisClient) {
    const dir = await redisClient.config('GET', 'dir');
    const dbfilename = await redisClient.config('GET', 'dbfilename');

    return {
      dir: dir[1] || '/var/lib/redis',
      dbfilename: dbfilename[1] || 'dump.rdb'
    };
  }

  /**
   * Trigger BGSAVE on Redis instance
   * @param {Object} redisClient - ioredis client
   * @returns {boolean} Success status
   */
  async _triggerBGSAVE(redisClient) {
    try {
      const result = await redisClient.bgsave();
      
      // Result is "Background saving started" or "Background saving already in progress"
      if (result.includes('already in progress')) {
        console.log('[RedisBackup] BGSAVE already in progress, waiting for completion');
      } else {
        console.log('[RedisBackup] BGSAVE started');
      }
      
      return true;
    } catch (error) {
      console.error('[RedisBackup] Failed to trigger BGSAVE:', error);
      return false;
    }
  }

  /**
   * Wait for BGSAVE to complete by monitoring LASTSAVE timestamp
   * @param {Object} redisClient - ioredis client
   * @returns {boolean} Success status
   */
  async _waitForBGSAVE(redisClient) {
    const initialLastSave = await redisClient.lastsave();
    console.log(`[RedisBackup] Initial LASTSAVE: ${initialLastSave}`);

    const startTime = Date.now();
    const maxWaitMs = this.maxWaitSeconds * 1000;

    while (Date.now() - startTime < maxWaitMs) {
      await this._sleep(1000); // Wait 1 second

      const currentLastSave = await redisClient.lastsave();
      
      // Check if LASTSAVE timestamp has changed
      if (currentLastSave !== initialLastSave) {
        console.log(`[RedisBackup] BGSAVE completed, new LASTSAVE: ${currentLastSave}`);
        return true;
      }

      // Check if BGSAVE is still in progress
      const info = await redisClient.info('persistence');
      const bgsaveInProgress = info.includes('rdb_bgsave_in_progress:1');
      
      if (!bgsaveInProgress && currentLastSave === initialLastSave) {
        // BGSAVE might have finished before we started waiting
        console.log('[RedisBackup] BGSAVE completed (detected via INFO)');
        return true;
      }

      console.log(`[RedisBackup] Waiting for BGSAVE... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }

    console.error(`[RedisBackup] BGSAVE did not complete within ${this.maxWaitSeconds} seconds`);
    return false;
  }

  /**
   * Compress file using gzip
   * @param {string} inputPath - Input file path
   * @param {string} outputPath - Output .gz file path
   * @returns {Object} { size, checksum }
   */
  async _compressFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const compressionLevel = this.config.backup.compressionLevel || 6;
      const gzip = spawn('gzip', [`-${compressionLevel}`, '-c', inputPath]);
      const writeStream = fs.createWriteStream(outputPath);
      
      const hash = crypto.createHash('sha256');
      let totalSize = 0;

      gzip.stdout.on('data', (chunk) => {
        hash.update(chunk);
        totalSize += chunk.length;
      });

      gzip.stdout.pipe(writeStream);

      gzip.on('error', (error) => {
        console.error('[RedisBackup] gzip error:', error);
        reject(new Error(`gzip failed: ${error.message}`));
      });

      writeStream.on('error', (error) => {
        console.error('[RedisBackup] Write error:', error);
        reject(new Error(`Write failed: ${error.message}`));
      });

      writeStream.on('finish', () => {
        const checksum = hash.digest('hex');
        resolve({
          size: totalSize,
          checksum: checksum
        });
      });
    });
  }

  /**
   * Restore Redis instance from RDB backup using DEBUG RELOAD (zero downtime)
   * @param {Object} redisClient - ioredis client
   * @param {string} instanceName - Instance name
   * @param {string} backupPath - Path to .rdb.gz backup file
   * @returns {Object} Restore result
   */
  async restore(redisClient, instanceName, backupPath) {
    const startTime = Date.now();
    console.log(`[RedisBackup] Starting restore for ${instanceName} from: ${backupPath}`);

    try {
      if (!await fs.pathExists(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }

      // Decompress RDB file to temp location
      const tempRdbPath = backupPath.replace('.gz', '');
      await this._decompressFile(backupPath, tempRdbPath);

      // Read RDB file content
      const rdbContent = await fs.readFile(tempRdbPath);
      const rdbBase64 = rdbContent.toString('base64');

      // Clean up temp RDB file
      await fs.remove(tempRdbPath);

      // Use DEBUG RELOAD for zero-downtime restore
      console.log(`[RedisBackup] Executing DEBUG RELOAD for ${instanceName}...`);
      await redisClient.send_command('DEBUG', ['RELOAD', rdbBase64]);

      const duration = Date.now() - startTime;
      console.log(`[RedisBackup] ${instanceName} restored successfully in ${duration}ms (no restart required)`);

      return {
        success: true,
        instance: instanceName,
        duration: duration
      };
    } catch (error) {
      console.error(`[RedisBackup] ${instanceName} restore failed:`, error);
      return {
        success: false,
        instance: instanceName,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Decompress .gz file
   * @param {string} inputPath - Input .gz file path
   * @param {string} outputPath - Output file path
   */
  async _decompressFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const gunzip = spawn('gunzip', ['-c', inputPath]);
      const writeStream = fs.createWriteStream(outputPath);

      gunzip.stdout.pipe(writeStream);

      gunzip.on('error', (error) => {
        console.error('[RedisBackup] gunzip error:', error);
        reject(new Error(`gunzip failed: ${error.message}`));
      });

      writeStream.on('error', (error) => {
        console.error('[RedisBackup] Write error:', error);
        reject(new Error(`Write failed: ${error.message}`));
      });

      writeStream.on('finish', () => {
        resolve();
      });
    });
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = RedisBackup;
