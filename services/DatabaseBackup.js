/**
 * Database Backup - Creates compressed PostgreSQL backups using pg_dump
 * Streams: pg_dump → gzip → temp file → B2 upload
 */

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const BackblazeFileManager = require('../util/BackblazeFileManager');

class DatabaseBackup {
  constructor(config) {
    this.config = config;
  }

  /**
   * Create a compressed database backup and upload to B2
   * @param {string} tempDir - Temporary directory for backup files
   * @returns {Object} Backup result { b2FileId, size, checksum, duration }
   */
  async create(tempDir) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const backupFileName = `${timestamp}.sql.gz`;
    const backupFilePath = path.join(tempDir, backupFileName);
    const b2Path = `backups/db/${backupFileName}`;

    console.log(`[DatabaseBackup] Starting backup: ${backupFileName}`);

    try {
      // Ensure temp directory exists
      await fs.ensureDir(tempDir);

      // Create backup with streaming compression
      const { size, checksum } = await this._createCompressedBackup(backupFilePath);

      // Upload to B2
      console.log(`[DatabaseBackup] Uploading to B2: ${b2Path}`);
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
      console.log(`[DatabaseBackup] Completed in ${duration}ms, size: ${size} bytes`);

      return {
        success: true,
        b2FileId: uploadResult.fileId,
        size: size,
        checksum: `sha256:${checksum}`,
        duration: duration,
        b2Path: b2Path
      };
    } catch (error) {
      console.error('[DatabaseBackup] Backup failed:', error);

      // Clean up temp file if it exists
      try {
        await fs.remove(backupFilePath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Create compressed backup using pg_dump piped through gzip
   * @param {string} outputPath - Path to output .sql.gz file
   * @returns {Object} { size, checksum }
   */
  async _createCompressedBackup(outputPath) {
    return new Promise((resolve, reject) => {
      const compressionLevel = this.config.backup.compressionLevel || 6;
      const databaseUrl = process.env.DATABASE_URL;

      if (!databaseUrl) {
        return reject(new Error('DATABASE_URL environment variable not set'));
      }

      // pg_dump command with options
      const pgDump = spawn('pg_dump', [
        databaseUrl,
        '--no-owner',
        '--no-acl',
        '--clean',
        '--if-exists',
        '--format=plain'
      ]);

      // gzip compression
      const gzip = spawn('gzip', [`-${compressionLevel}`]);

      // Create write stream
      const writeStream = fs.createWriteStream(outputPath);
      
      // Initialize hash for checksum
      const hash = crypto.createHash('sha256');
      let totalSize = 0;

      // Pipeline: pg_dump → gzip → file (with checksum)
      pgDump.stdout.pipe(gzip.stdin);
      
      gzip.stdout.on('data', (chunk) => {
        hash.update(chunk);
        totalSize += chunk.length;
      });

      gzip.stdout.pipe(writeStream);

      // Handle errors
      pgDump.on('error', (error) => {
        console.error('[DatabaseBackup] pg_dump error:', error);
        reject(new Error(`pg_dump failed: ${error.message}`));
      });

      gzip.on('error', (error) => {
        console.error('[DatabaseBackup] gzip error:', error);
        reject(new Error(`gzip failed: ${error.message}`));
      });

      writeStream.on('error', (error) => {
        console.error('[DatabaseBackup] Write error:', error);
        reject(new Error(`Write failed: ${error.message}`));
      });

      // Handle completion
      writeStream.on('finish', () => {
        const checksum = hash.digest('hex');
        console.log(`[DatabaseBackup] Backup created: ${totalSize} bytes, checksum: ${checksum}`);
        resolve({
          size: totalSize,
          checksum: checksum
        });
      });

      // Handle pg_dump stderr (for warnings, not errors)
      pgDump.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message && !message.includes('NOTICE')) {
          console.warn('[DatabaseBackup] pg_dump warning:', message);
        }
      });
    });
  }

  /**
   * Restore database from backup file
   * @param {string} backupPath - Path to .sql.gz backup file
   * @returns {Object} Restore result
   */
  async restore(backupPath) {
    const startTime = Date.now();
    console.log(`[DatabaseBackup] Starting restore from: ${backupPath}`);

    try {
      const databaseUrl = process.env.DATABASE_URL;

      if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable not set');
      }

      if (!await fs.pathExists(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }

      // Decompress and restore
      const gunzip = spawn('gunzip', ['-c', backupPath]);
      const psql = spawn('psql', [databaseUrl, '--quiet', '--no-psqlrc']);

      // Pipeline: gunzip → psql
      gunzip.stdout.pipe(psql.stdin);

      return new Promise((resolve, reject) => {
        let errorOutput = '';

        psql.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        gunzip.on('error', (error) => {
          console.error('[DatabaseBackup] gunzip error:', error);
          reject(new Error(`gunzip failed: ${error.message}`));
        });

        psql.on('error', (error) => {
          console.error('[DatabaseBackup] psql error:', error);
          reject(new Error(`psql failed: ${error.message}`));
        });

        psql.on('close', (code) => {
          const duration = Date.now() - startTime;

          if (code === 0) {
            console.log(`[DatabaseBackup] Restore completed in ${duration}ms`);
            resolve({
              success: true,
              duration: duration
            });
          } else {
            console.error('[DatabaseBackup] psql exit code:', code);
            console.error('[DatabaseBackup] psql stderr:', errorOutput);
            reject(new Error(`psql exited with code ${code}: ${errorOutput}`));
          }
        });
      });
    } catch (error) {
      console.error('[DatabaseBackup] Restore failed:', error);
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }
}

module.exports = DatabaseBackup;
