import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { metrics } from './MetricsCollector.js';

export class S3FileManager {
  constructor(config) {
    this.config = config;
    
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle !== false,
      tlsRejectUnauthorized: config.endpoint?.startsWith('https') ?? true,
    });

    this.stagingBucket = config.stagingBucket || 'staging';
    this.productionBucket = config.productionBucket || 'production';
    this.backupBucket = config.backupBucket || 'backups';
    
    this.stagingFiles = new Map();
    this.productionFiles = new Map();
    
    this.syncIntervalMs = config.syncIntervalMs || 60000;
    this.syncTimer = null;
    
    this.stats = {
      totalDownloads: 0,
      totalBytesDownloaded: 0,
      totalUploads: 0,
      totalBytesUploaded: 0,
      lastSyncTime: null,
      filesTracked: { staging: 0, production: 0 },
    };
  }

  async initialize() {
    try {
      console.log('[S3FileManager] Initializing S3-compatible storage...');
      
      await this.ensureBucketsExist();
      
      console.log('[S3FileManager] S3 storage initialized successfully');
      
      await this.syncAllFiles();
      
      this.startPeriodicSync();
      
      return true;
    } catch (error) {
      console.error('[S3FileManager] Failed to initialize:', error);
      throw error;
    }
  }

  async ensureBucketsExist() {
    const buckets = [this.stagingBucket, this.productionBucket, this.backupBucket];
    
    for (const bucket of buckets) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
          console.log(`[S3FileManager] Creating bucket: ${bucket}`);
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
            console.log(`[S3FileManager] Created bucket: ${bucket}`);
          } catch (createError) {
            if (!createError.message?.includes('already owned by you')) {
              console.error(`[S3FileManager] Failed to create bucket ${bucket}:`, createError.message);
            }
          }
        }
      }
    }
  }

  startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    console.log(`[S3FileManager] Starting periodic sync every ${this.syncIntervalMs}ms`);
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncAllFiles();
      } catch (error) {
        console.error('[S3FileManager] Error during periodic sync:', error);
      }
    }, this.syncIntervalMs);
  }

  async syncAllFiles() {
    const startTime = Date.now();
    
    try {
      const [stagingFiles, productionFiles] = await Promise.all([
        this.syncBucket(this.stagingBucket, this.stagingFiles),
        this.syncBucket(this.productionBucket, this.productionFiles),
      ]);

      this.stats.filesTracked = {
        staging: this.stagingFiles.size,
        production: this.productionFiles.size,
      };
      this.stats.lastSyncTime = new Date().toISOString();

      const duration = Date.now() - startTime;
      console.log(
        `[S3FileManager] Synced ${stagingFiles} staging and ${productionFiles} production files in ${duration}ms`
      );
    } catch (error) {
      console.error('[S3FileManager] Error syncing files:', error);
      throw error;
    }
  }

  async syncBucket(bucketName, fileMap) {
    let fileCount = 0;
    let continuationToken = undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
        })
      );

      const objects = response.Contents || [];
      
      for (const object of objects) {
        const fileName = object.Key;
        const existingFile = fileMap.get(fileName);
        
        if (!existingFile || existingFile.lastModified < object.LastModified) {
          try {
            const fileData = await this.downloadFile(bucketName, fileName);
            fileMap.set(fileName, {
              buffer: fileData.buffer,
              hash: this.calculateHash(fileData.buffer),
              size: object.Size,
              lastModified: object.LastModified,
              etag: object.ETag,
            });
            fileCount++;
          } catch (downloadError) {
            console.error(`[S3FileManager] Failed to sync ${fileName}:`, downloadError.message);
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return fileCount;
  }

  async downloadFile(bucketName, fileName) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: fileName,
      })
    );

    const buffer = Buffer.from(await response.Body.transformToByteArray());
    
    this.stats.totalDownloads++;
    this.stats.totalBytesDownloaded += buffer.length;

    return {
      buffer,
      contentType: response.ContentType,
      etag: response.ETag,
      lastModified: response.LastModified,
    };
  }

  async uploadFile(bucketName, fileName, buffer, contentType = 'application/octet-stream') {
    const hash = this.calculateHash(buffer);
    
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: buffer,
        ContentType: contentType,
        Metadata: {
          'sha256-hash': hash,
        },
      })
    );

    this.stats.totalUploads++;
    this.stats.totalBytesUploaded += buffer.length;

    const fileMap = bucketName === this.stagingBucket ? this.stagingFiles : this.productionFiles;
    fileMap.set(fileName, {
      buffer,
      hash,
      size: buffer.length,
      lastModified: new Date(),
    });

    return { hash, size: buffer.length };
  }

  async getFile(bucketName, fileName) {
    const fileMap = bucketName === this.stagingBucket ? this.stagingFiles : this.productionBucket;
    
    if (fileMap && fileMap.has(fileName)) {
      const cached = fileMap.get(fileName);
      return {
        buffer: cached.buffer,
        hash: cached.hash,
        size: cached.size,
      };
    }

    const fileData = await this.downloadFile(bucketName, fileName);
    return {
      buffer: fileData.buffer,
      hash: this.calculateHash(fileData.buffer),
      size: fileData.buffer.length,
    };
  }

  async deleteFile(bucketName, fileName) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: fileName,
      })
    );

    const fileMap = bucketName === this.stagingBucket ? this.stagingFiles : this.productionFiles;
    fileMap.delete(fileName);
  }

  calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async healthCheck() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.stagingBucket }));
      return {
        status: 'healthy',
        service: 's3-storage',
        endpoint: this.config.endpoint,
        buckets: {
          staging: this.stagingBucket,
          production: this.productionBucket,
        },
        filesTracked: this.stats.filesTracked,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        service: 's3-storage',
        error: error.message,
      };
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async shutdown() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('[S3FileManager] Shutdown complete');
  }
}