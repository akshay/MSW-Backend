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
  }
};
