import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import NodeCache from 'node-cache';

dotenv.config();

// Prisma client for CockroachDB
export const prisma = new PrismaClient({
  log: ['info', 'warn', 'error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

export const ephemeralRedis = new Redis(process.env.EPHEMERAL_REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  maxmemory: '256mb',
  'maxmemory-policy': 'allkeys-lru'
});

export const streamRedis = new Redis(process.env.STREAM_REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  maxmemory: '32mb',
  'maxmemory-policy': 'allkeys-lru'
});

export const cacheRedis = new Redis(process.env.CACHE_REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  maxmemory: '32mb',
  'maxmemory-policy': 'volatile-ttl'
});

export const auditRedis = new Redis(process.env.AUDIT_REDIS_URL || process.env.STREAM_REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  maxmemory: '512mb',
  'maxmemory-policy': 'allkeys-lru'
});

// In-memory cache with configurable TTL and max size
export const cacheTTL = parseInt(process.env.CACHE_TTL_SECONDS) || 300; // Default: 5 minutes
export const cacheMaxSize = parseInt(process.env.CACHE_MAX_SIZE) || 10000; // Default: 10,000 entries

export const memoryCache = new NodeCache({
  stdTTL: cacheTTL,
  maxKeys: cacheMaxSize,
  checkperiod: Math.max(60, Math.floor(cacheTTL / 5)) // Check every 60s or TTL/5, whichever is larger
});

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Environment whitelist - only these environments are allowed
  allowedEnvironments: ['staging', 'production'],

  // Entity type configuration
  entityTypes: {
    persistent: ['Account', 'Guild', 'Alliance', 'Party', 'PlayerCharacter'],
    ephemeral: ['OnlineMapData', 'Channel', 'World']
  },

  // TTL configurations (in seconds)
  ephemeral: {
    versionCacheTTL: parseInt(process.env.EPHEMERAL_VERSION_CACHE_TTL_SECONDS) || 3600, // Default: 1 hour
    batchSize: parseInt(process.env.EPHEMERAL_BATCH_SIZE) || 5000 // Default: 5000
  },

  // Background persistence configurations
  backgroundPersistence: {
    lockTTL: parseInt(process.env.BG_PERSISTENCE_LOCK_TTL_SECONDS) || 10, // Default: 10 seconds
    batchSize: parseInt(process.env.BG_PERSISTENCE_BATCH_SIZE) || 500, // Default: 500
    intervalMs: parseInt(process.env.BG_PERSISTENCE_INTERVAL_MS) || 5000, // Default: 5 seconds
    maxRetries: parseInt(process.env.BG_PERSISTENCE_MAX_RETRIES) || 3, // Default: 3
    retryDelayMs: parseInt(process.env.BG_PERSISTENCE_RETRY_DELAY_MS) || 1000 // Default: 1 second
  },

  // Persistent entity configurations
  persistent: {
    batchSize: parseInt(process.env.PERSISTENT_BATCH_SIZE) || 5000 // Default: 5000
  },

  // Stream configurations
  stream: {
    worldInstanceTTL: parseInt(process.env.STREAM_WORLD_INSTANCE_TTL_SECONDS) || Math.floor(cacheTTL / 100) || 3 // Default: cacheTTL/100 or 3 seconds
  },

  // Distributed lock configurations
  lock: {
    defaultTTL: parseInt(process.env.LOCK_DEFAULT_TTL_SECONDS) || 10, // Default: 10 seconds
    retryDelayMs: parseInt(process.env.LOCK_RETRY_DELAY_MS) || 100, // Default: 100ms
    maxRetries: parseInt(process.env.LOCK_MAX_RETRIES) || 3 // Default: 3
  },

  // Presence and population settings
  presence: {
    heartbeatIntervalMs: parseInt(process.env.PRESENCE_HEARTBEAT_INTERVAL_MS) || 30000, // Default: 30 seconds
    ttlMs: parseInt(process.env.PRESENCE_TTL_MS) || 60000, // Default: 1 minute
    cleanupIntervalMs: parseInt(process.env.PRESENCE_CLEANUP_INTERVAL_MS) || 15000, // Default: 15 seconds
    cleanupBatchSize: parseInt(process.env.PRESENCE_CLEANUP_BATCH_SIZE) || 500, // Default: 500 accounts per cycle
    snapshotCacheMs: parseInt(process.env.PRESENCE_SNAPSHOT_CACHE_MS) || 30000, // Default: 30 seconds
    cleanupLockTTLSeconds: parseInt(process.env.PRESENCE_CLEANUP_LOCK_TTL_SECONDS) || 10 // Default: 10 seconds
  },

  // Backblaze B2 Configuration
  backblaze: {
    keyId: process.env.BACKBLAZE_KEY_ID,
    key: process.env.BACKBLAZE_KEY,
    stagingBucket: process.env.BACKBLAZE_STAGING_BUCKET,
    productionBucket: process.env.BACKBLAZE_PRODUCTION_BUCKET,
    syncIntervalMs: parseInt(process.env.FILE_SYNC_INTERVAL_MS) || 60000, // Default: 60 seconds
    enabled: process.env.FILE_SYNC_ENABLED === 'true' || false
  },

  // S3-compatible storage Configuration (MinIO, Backblaze S3 API, AWS S3, etc.)
  s3: {
    endpoint: process.env.S3_ENDPOINT || null, // e.g., http://localhost:9000 for MinIO
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.BACKBLAZE_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.BACKBLAZE_KEY,
    stagingBucket: process.env.S3_STAGING_BUCKET || process.env.BACKBLAZE_STAGING_BUCKET || 'staging',
    productionBucket: process.env.S3_PRODUCTION_BUCKET || process.env.BACKBLAZE_PRODUCTION_BUCKET || 'production',
    backupBucket: process.env.S3_BACKUP_BUCKET || 'backups',
    syncIntervalMs: parseInt(process.env.FILE_SYNC_INTERVAL_MS) || 60000,
    enabled: process.env.FILE_SYNC_ENABLED === 'true' || false,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false' // Required for MinIO
  },

  // Hot-reload config sync settings
  configSync: {
    enabled: process.env.CONFIG_SYNC_ENABLED === 'true' || process.env.FILE_SYNC_ENABLED === 'true' || false,
    configDir: process.env.CONFIG_SYNC_DIR || '../MSW-Tools/data/config',
    currentManifestPath: process.env.CONFIG_CURRENT_MANIFEST_PATH || 'current/manifest.json',
    manifestsPrefix: process.env.CONFIG_MANIFEST_PREFIX || 'manifests',
    filesPrefix: process.env.CONFIG_FILES_PREFIX || 'config',
    pollIntervalMs: parseInt(process.env.CONFIG_POLL_INTERVAL_MS) || 20000, // Default: 20 seconds
    maxVersionGapForDiff: parseInt(process.env.CONFIG_MAX_VERSION_GAP_FOR_DIFF) || 25,
    healthRetentionSeconds: parseInt(process.env.CONFIG_HEALTH_RETENTION_SECONDS) || (7 * 24 * 60 * 60)
  },

  // Backup configuration
  backup: {
    enabled: process.env.BACKUP_ENABLED === 'true',
    schedule: process.env.BACKUP_SCHEDULE || '0 */6 * * *',
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS) || 7,
    compressionLevel: parseInt(process.env.BACKUP_COMPRESSION_LEVEL) || 6,
    b2Bucket: process.env.BACKBLAZE_BACKUP_BUCKET || process.env.BACKBLAZE_PRODUCTION_BUCKET,
    b2Prefix: 'backups',
    b2BucketId: null,
    tempDir: process.env.BACKUP_TEMP_DIR || '/tmp/msw-backups',
    workerPort: parseInt(process.env.BACKUP_WORKER_PORT) || 3001,
    redisInstances: [
      { name: 'cache', envKey: 'CACHE_REDIS_URL' },
      { name: 'ephemeral', envKey: 'EPHEMERAL_REDIS_URL' },
      { name: 'stream', envKey: 'STREAM_REDIS_URL' }
    ],
    logRetentionDays: parseInt(process.env.BACKUP_LOG_RETENTION_DAYS) || 7
  },

  audit: {
    enabled: process.env.AUDIT_ENABLED !== 'false',
    streamKey: process.env.AUDIT_STREAM_KEY || 'audit:commands',
    maxStreamLength: parseInt(process.env.AUDIT_STREAM_MAX_LEN) || 500000,
    streamTTL: parseInt(process.env.AUDIT_STREAM_TTL_SECONDS) || 604800,
    archiveIntervalMs: parseInt(process.env.AUDIT_ARCHIVE_INTERVAL_MS) || 5000,
    batchSize: parseInt(process.env.AUDIT_BATCH_SIZE) || 1000,
    dbRetentionDays: parseInt(process.env.AUDIT_DB_RETENTION_DAYS) || 30,
    lockTTL: parseInt(process.env.AUDIT_LOCK_TTL_SECONDS) || 10,
    skipCommands: ['emit', 'presence']
  }
};
