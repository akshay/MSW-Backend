// util/BackblazeFileManager.js
import B2 from 'backblaze-b2';
import crypto from 'crypto';
import { metrics } from './MetricsCollector.js';

/**
 * BackblazeFileManager handles file synchronization with Backblaze B2
 * - Downloads and caches files from B2
 * - Tracks file versions and SHA256 hashes
 * - Periodically syncs new file versions
 * - Manages both staging and production environments
 */
export class BackblazeFileManager {
  constructor(config) {
    this.config = config;
    this.b2 = new B2({
      applicationKeyId: config.keyId,
      applicationKey: config.key,
    });

    // In-memory file cache: { fileName: { buffer, hash, versionId, fileSize, lastUpdated } }
    this.stagingFiles = new Map();
    this.productionFiles = new Map();

    // Track initialization and authorization
    this.isAuthorized = false;
    this.authorizationData = null;

    // Sync interval (default: 60 seconds)
    this.syncIntervalMs = config.syncIntervalMs || 60000;
    this.syncTimer = null;

    // Track metrics
    this.stats = {
      totalDownloads: 0,
      totalBytesDownloaded: 0,
      lastSyncTime: null,
      filesTracked: { staging: 0, production: 0 },
    };
  }

  /**
   * Initialize the file manager by authorizing with B2
   */
  async initialize() {
    try {
      console.log('[BackblazeFileManager] Authorizing with Backblaze B2...');
      await this.b2.authorize();
      this.isAuthorized = true;
      this.authorizationData = this.b2.data;
      console.log('[BackblazeFileManager] Successfully authorized with B2');

      // Initial sync of all files
      await this.syncAllFiles();

      // Start periodic sync
      this.startPeriodicSync();

      return true;
    } catch (error) {
      console.error('[BackblazeFileManager] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Start periodic background sync of files
   */
  startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    console.log(`[BackblazeFileManager] Starting periodic sync every ${this.syncIntervalMs}ms`);
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncAllFiles();
      } catch (error) {
        console.error('[BackblazeFileManager] Error during periodic sync:', error);
        metrics.recordError('file_sync', error);
      }
    }, this.syncIntervalMs);
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('[BackblazeFileManager] Stopped periodic sync');
    }
  }

  /**
   * Sync all files for both staging and production environments
   */
  async syncAllFiles() {
    const syncStartTime = performance.now();
    console.log('[BackblazeFileManager] Starting file sync...');

    try {
      // Sync both environments in parallel
      const [stagingResults, productionResults] = await Promise.all([
        this.syncEnvironmentFiles('staging', this.config.stagingBucket),
        this.syncEnvironmentFiles('production', this.config.productionBucket),
      ]);

      this.stats.lastSyncTime = new Date().toISOString();
      this.stats.filesTracked.staging = this.stagingFiles.size;
      this.stats.filesTracked.production = this.productionFiles.size;

      const syncDuration = performance.now() - syncStartTime;
      console.log(`[BackblazeFileManager] Sync completed in ${syncDuration.toFixed(2)}ms`);
      console.log(`[BackblazeFileManager] Files tracked - Staging: ${this.stagingFiles.size}, Production: ${this.productionFiles.size}`);

      metrics.recordDuration('file_sync', syncDuration);

      return {
        staging: stagingResults,
        production: productionResults,
        duration: syncDuration,
      };
    } catch (error) {
      console.error('[BackblazeFileManager] Error syncing files:', error);
      metrics.recordError('file_sync', error);
      throw error;
    }
  }

  /**
   * Sync files for a specific environment
   */
  async syncEnvironmentFiles(environment, bucketName) {
    try {
      // List all file versions in the bucket
      const fileVersions = await this.listFileVersions(bucketName);

      const fileCache = environment === 'staging' ? this.stagingFiles : this.productionFiles;
      const updatedFiles = [];
      const newFiles = [];

      // Group versions by file name (get latest version for each file)
      const latestVersions = this.getLatestVersions(fileVersions);

      // Check each file and download if needed
      for (const [fileName, fileInfo] of latestVersions.entries()) {
        const cachedFile = fileCache.get(fileName);

        // Download if file is not cached or version has changed
        if (!cachedFile || cachedFile.versionId !== fileInfo.fileId) {
          console.log(`[BackblazeFileManager] ${environment}: Downloading ${fileName} (version: ${fileInfo.fileId})`);

          const fileData = await this.downloadFile(fileInfo.fileId, fileName);

          fileCache.set(fileName, {
            buffer: fileData.buffer,
            hash: fileData.hash,
            versionId: fileInfo.fileId,
            fileSize: fileData.buffer.length,
            lastUpdated: new Date().toISOString(),
          });

          if (cachedFile) {
            updatedFiles.push(fileName);
          } else {
            newFiles.push(fileName);
          }

          this.stats.totalDownloads++;
          this.stats.totalBytesDownloaded += fileData.buffer.length;
        }
      }

      // Remove files that no longer exist in B2
      const currentFileNames = new Set(latestVersions.keys());
      for (const cachedFileName of fileCache.keys()) {
        if (!currentFileNames.has(cachedFileName)) {
          console.log(`[BackblazeFileManager] ${environment}: Removing deleted file ${cachedFileName} from cache`);
          fileCache.delete(cachedFileName);
        }
      }

      return {
        environment,
        totalFiles: fileCache.size,
        newFiles: newFiles.length,
        updatedFiles: updatedFiles.length,
        filesRemoved: fileCache.size - latestVersions.size,
      };
    } catch (error) {
      console.error(`[BackblazeFileManager] Error syncing ${environment} files:`, error);
      throw error;
    }
  }

  /**
   * List all file versions in a bucket with batching support
   */
  async listFileVersions(bucketName) {
    try {
      const allVersions = [];
      let startFileName = null;
      let startFileId = null;

      // B2 API returns up to 10,000 files per request, so we need to paginate
      while (true) {
        const response = await this.b2.listFileVersions({
          bucketName,
          maxFileCount: 10000,
          startFileName,
          startFileId,
        });

        allVersions.push(...response.data.files);

        // Check if there are more files to fetch
        if (response.data.nextFileName && response.data.nextFileId) {
          startFileName = response.data.nextFileName;
          startFileId = response.data.nextFileId;
        } else {
          break;
        }
      }

      return allVersions;
    } catch (error) {
      console.error(`[BackblazeFileManager] Error listing file versions in ${bucketName}:`, error);
      throw error;
    }
  }

  /**
   * Get the latest version for each file name
   */
  getLatestVersions(fileVersions) {
    const latestVersions = new Map();

    for (const file of fileVersions) {
      const fileName = file.fileName;
      const existing = latestVersions.get(fileName);

      // Keep the version with the latest upload timestamp
      if (!existing || file.uploadTimestamp > existing.uploadTimestamp) {
        latestVersions.set(fileName, file);
      }
    }

    return latestVersions;
  }

  /**
   * Download a file from B2 by file ID
   */
  async downloadFile(fileId, fileName) {
    try {
      const downloadStartTime = performance.now();

      const response = await this.b2.downloadFileById({
        fileId,
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data);
      const hash = this.calculateSHA256(buffer);

      const downloadDuration = performance.now() - downloadStartTime;
      console.log(`[BackblazeFileManager] Downloaded ${fileName} (${buffer.length} bytes) in ${downloadDuration.toFixed(2)}ms`);

      metrics.recordDuration('file_download', downloadDuration);

      return { buffer, hash };
    } catch (error) {
      console.error(`[BackblazeFileManager] Error downloading file ${fileName}:`, error);
      metrics.recordError('file_download', error);
      throw error;
    }
  }

  /**
   * Calculate SHA256 hash of a buffer
   */
  calculateSHA256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Get file data from cache by environment and file name
   */
  getFile(environment, fileName) {
    const fileCache = environment === 'staging' ? this.stagingFiles : this.productionFiles;
    return fileCache.get(fileName);
  }

  /**
   * Check if files match the expected hashes
   * Returns a map of files that don't match with their expected hashes and sizes
   */
  validateFileHashes(environment, fileHashMap) {
    const fileCache = environment === 'staging' ? this.stagingFiles : this.productionFiles;
    const mismatches = {};

    for (const [fileName, expectedHash] of Object.entries(fileHashMap)) {
      const cachedFile = fileCache.get(fileName);

      if (cachedFile && cachedFile.hash !== expectedHash) {
        mismatches[fileName] = {
          expectedHash: cachedFile.hash,
          fileSize: cachedFile.fileSize,
        };
      }
    }

    return mismatches;
  }

  /**
   * Get a chunk of file data for progressive download
   * Returns the file content from the specified offset
   */
  getFileChunk(environment, fileName, offset = 0, maxBytes = null) {
    const cachedFile = this.getFile(environment, fileName);

    if (!cachedFile) {
      return null;
    }

    const { buffer, hash, fileSize } = cachedFile;

    // Calculate how much to send
    const remainingBytes = fileSize - offset;
    const bytesToSend = maxBytes ? Math.min(remainingBytes, maxBytes) : remainingBytes;

    // Extract the chunk
    const chunk = buffer.slice(offset, offset + bytesToSend);

    return {
      fileName,
      hash,
      fileSize,
      offset,
      bytesToSend,
      remainingBytes: remainingBytes - bytesToSend,
      chunk,
    };
  }

  /**
   * Get all cached file names for an environment
   */
  getCachedFileNames(environment) {
    const fileCache = environment === 'staging' ? this.stagingFiles : this.productionFiles;
    return Array.from(fileCache.keys());
  }

  /**
   * Get statistics about the file manager
   */
  getStats() {
    return {
      ...this.stats,
      isAuthorized: this.isAuthorized,
      syncIntervalMs: this.syncIntervalMs,
      stagingFiles: Array.from(this.stagingFiles.keys()).map(fileName => ({
        fileName,
        fileSize: this.stagingFiles.get(fileName).fileSize,
        hash: this.stagingFiles.get(fileName).hash,
        versionId: this.stagingFiles.get(fileName).versionId,
      })),
      productionFiles: Array.from(this.productionFiles.keys()).map(fileName => ({
        fileName,
        fileSize: this.productionFiles.get(fileName).fileSize,
        hash: this.productionFiles.get(fileName).hash,
        versionId: this.productionFiles.get(fileName).versionId,
      })),
    };
  }

  /**
   * Health check for the file manager
   */
  async healthCheck() {
    try {
      if (!this.isAuthorized) {
        return {
          status: 'unhealthy',
          message: 'Not authorized with Backblaze B2',
        };
      }

      return {
        status: 'healthy',
        filesTracked: this.stats.filesTracked,
        lastSyncTime: this.stats.lastSyncTime,
        totalDownloads: this.stats.totalDownloads,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error.message,
      };
    }
  }

  /**
   * Cleanup resources
   */
  async shutdown() {
    console.log('[BackblazeFileManager] Shutting down...');
    this.stopPeriodicSync();

    // Clear caches
    this.stagingFiles.clear();
    this.productionFiles.clear();

    console.log('[BackblazeFileManager] Shutdown complete');
  }
}
