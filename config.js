import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import NodeCache from 'node-cache';

dotenv.config();

// Prisma client for CockroachDB
export const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
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

// In-memory cache
export const memoryCache = new NodeCache({
  stdTTL: 300, // 5 minutes default
  maxKeys: 3000,
  checkperiod: 60
});

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Entity type configuration
  entityTypes: {
    persistent: ['Account', 'Guild', 'Alliance', 'Party', 'PlayerCharacter'],
    ephemeral: ['OnlineMapData']
  }
};
