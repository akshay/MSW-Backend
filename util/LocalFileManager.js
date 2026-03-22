import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { metrics } from './MetricsCollector.js';

export class LocalFileManager {
  constructor(config) {
    this.configDir = config.configDir || '../MSW-Tools/data/config';
    this.enabled = config.enabled !== false;
    
    this.stagingFiles = new Map();
    this.productionFiles = new Map();
    
    this.syncIntervalMs = config.syncIntervalMs || 60000;
    this.syncTimer = null;
    
    this.stats = {
      totalReads: 0,
      totalBytesRead: 0,
      lastSyncTime: null,
      filesTracked: { staging: 0, production: 0 },
    };
  }

  async initialize() {
    if (!this.enabled) {
      console.log('[LocalFileManager] File sync disabled');
      return false;
    }

    try {
      const absolutePath = path.resolve(this.configDir);
      
      if (!fs.existsSync(absolutePath)) {
        console.warn(`[LocalFileManager] Config directory not found: ${absolutePath}`);
        return false;
      }

      console.log(`[LocalFileManager] Initialized with config dir: ${absolutePath}`);
      
      await this.syncAllFiles();
      this.startPeriodicSync();
      
      return true;
    } catch (error) {
      console.error('[LocalFileManager] Failed to initialize:', error);
      return false;
    }
  }

  startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    console.log(`[LocalFileManager] Starting periodic sync every ${this.syncIntervalMs}ms`);
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncAllFiles();
      } catch (error) {
        console.error('[LocalFileManager] Error during periodic sync:', error);
      }
    }, this.syncIntervalMs);
  }

  async syncAllFiles() {
    const startTime = Date.now();
    const absolutePath = path.resolve(this.configDir);

    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const files = fs.readdirSync(absolutePath);
    let fileCount = 0;

    for (const fileName of files) {
      const filePath = path.join(absolutePath, fileName);
      
      if (!fs.statSync(filePath).isFile()) {
        continue;
      }

      try {
        const buffer = fs.readFileSync(filePath);
        const hash = this.calculateHash(buffer);
        const stat = fs.statSync(filePath);

        const fileInfo = {
          buffer,
          hash,
          size: buffer.length,
          lastModified: stat.mtime,
        };

        this.stagingFiles.set(fileName, fileInfo);
        this.productionFiles.set(fileName, fileInfo);
        fileCount++;
      } catch (error) {
        console.error(`[LocalFileManager] Failed to sync ${fileName}:`, error.message);
      }
    }

    this.stats.filesTracked = {
      staging: this.stagingFiles.size,
      production: this.productionFiles.size,
    };
    this.stats.lastSyncTime = new Date().toISOString();

    const duration = Date.now() - startTime;
    console.log(`[LocalFileManager] Synced ${fileCount} files in ${duration}ms`);
  }

  async getFile(bucketName, fileName) {
    const fileMap = bucketName === 'production' ? this.productionFiles : this.stagingFiles;
    
    if (fileMap.has(fileName)) {
      const cached = fileMap.get(fileName);
      this.stats.totalReads++;
      this.stats.totalBytesRead += cached.size;
      return {
        buffer: cached.buffer,
        hash: cached.hash,
        size: cached.size,
      };
    }

    const absolutePath = path.resolve(this.configDir);
    const filePath = path.join(absolutePath, fileName);

    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      const hash = this.calculateHash(buffer);
      
      fileMap.set(fileName, {
        buffer,
        hash,
        size: buffer.length,
        lastModified: new Date(),
      });

      this.stats.totalReads++;
      this.stats.totalBytesRead += buffer.length;

      return { buffer, hash, size: buffer.length };
    }

    return null;
  }

  async getFileChunk(bucketName, fileName, offset, length) {
    const file = await this.getFile(bucketName, fileName);
    if (!file) {
      return null;
    }

    const end = Math.min(offset + length, file.buffer.length);
    const chunk = file.buffer.slice(offset, end);

    return {
      buffer: chunk,
      offset,
      length: chunk.length,
      totalSize: file.buffer.length,
    };
  }

  calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async healthCheck() {
    const absolutePath = path.resolve(this.configDir);
    const exists = fs.existsSync(absolutePath);

    return {
      status: exists ? 'healthy' : 'unhealthy',
      service: 'local-storage',
      configDir: absolutePath,
      filesTracked: this.stats.filesTracked,
    };
  }

  getStats() {
    return { ...this.stats };
  }

  async shutdown() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('[LocalFileManager] Shutdown complete');
  }
}