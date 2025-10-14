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
  'maxmemory-policy': 'noeviction'
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
  }
};
