// src/cache/HybridCacheManager.js
import { memoryCache, cacheRedis } from '../config.js';

export class HybridCacheManager {
  constructor() {
    this.dependencyMap = new Map(); // entityId -> Set of cache keys
    this.reverseMap = new Map();    // cache key -> Set of entityIds
    this.kvCache = cacheRedis;
  }

  async get(key) {
    // L1: Memory cache (fastest)
    const memoryResult = memoryCache.get(key);
    if (memoryResult !== undefined) {
      return memoryResult;
    }

    // L2: Render KV (Valkey) - Redis-compatible
    try {
      const kvResult = await this.kvCache.get(key);
      if (kvResult) {
        const parsed = JSON.parse(kvResult);
        // Promote to memory cache
        memoryCache.set(key, parsed, 300);
        return parsed;
      }
    } catch (error) {
      console.warn('KV cache miss:', error.message);
    }

    return null;
  }

  async set(key, value, ttl = 300, dependencies = []) {
    // L1: Store in memory
    memoryCache.set(key, value, ttl);

    // Track dependencies for invalidation
    if (dependencies.length > 0) {
      this.trackDependencies(key, dependencies);
    }

    // L2: Async write to Render KV (Valkey)
    setImmediate(async () => {
      try {
        await this.kvCache.setex(key, ttl, JSON.stringify(value));
      } catch (error) {
        console.warn('KV cache write failed:', error.message);
      }
    });
  }

  // Batch operations for better performance
  async mget(keys) {
    const results = new Map();
    const missingKeys = [];

    // Check memory cache first
    keys.forEach(key => {
      const memoryResult = memoryCache.get(key);
      if (memoryResult !== undefined) {
        results.set(key, memoryResult);
      } else {
        missingKeys.push(key);
      }
    });

    // Batch fetch missing keys from KV
    if (missingKeys.length > 0) {
      try {
        const kvResults = await this.kvCache.mget(...missingKeys);
        
        missingKeys.forEach((key, index) => {
          const value = kvResults[index];
          if (value !== null) {
            const parsed = JSON.parse(value);
            results.set(key, parsed);
            // Promote to memory
            memoryCache.set(key, parsed, 300);
          }
        });
      } catch (error) {
        console.warn('KV batch get failed:', error.message);
      }
    }

    return results;
  }

  async mset(entries, ttl = 300) {
    // Set in memory cache first
    entries.forEach(([key, value]) => {
      memoryCache.set(key, value, ttl);
    });

    // Batch set in KV (Valkey)
    setImmediate(async () => {
      try {
        const pipeline = this.kvCache.pipeline();
        
        entries.forEach(([key, value]) => {
          pipeline.setex(key, ttl, JSON.stringify(value));
        });
        
        await pipeline.exec();
      } catch (error) {
        console.warn('KV batch set failed:', error.message);
      }
    });
  }

  async invalidateEntity(entityId) {
    const keysToInvalidate = this.dependencyMap.get(entityId) || new Set();
    
    console.log(`Invalidating ${keysToInvalidate.size} cache entries for entity ${entityId}`);

    // Remove from memory cache
    for (const key of keysToInvalidate) {
      memoryCache.del(key);
    }

    // Batch remove from KV using pipeline
    if (keysToInvalidate.size > 0) {
      setImmediate(async () => {
        try {
          const pipeline = this.kvCache.pipeline();
          
          for (const key of keysToInvalidate) {
            pipeline.del(key);
          }
          
          await pipeline.exec();
        } catch (error) {
          console.warn('KV batch delete failed:', error);
        }
      });
    }

    // Clean up tracking maps
    for (const key of keysToInvalidate) {
      this.reverseMap.delete(key);
    }
    this.dependencyMap.delete(entityId);
  }

  async invalidateEntities(entityIds) {
    // Collect all keys to invalidate
    const allKeys = new Set();
    
    entityIds.forEach(entityId => {
      const keys = this.dependencyMap.get(entityId) || new Set();
      keys.forEach(key => allKeys.add(key));
    });

    console.log(`Batch invalidating ${allKeys.size} cache entries for ${entityIds.length} entities`);

    // Remove from memory cache
    for (const key of allKeys) {
      memoryCache.del(key);
    }

    // Batch remove from KV using pipeline
    if (allKeys.size > 0) {
      setImmediate(async () => {
        try {
          const pipeline = this.kvCache.pipeline();
          
          for (const key of allKeys) {
            pipeline.del(key);
          }
          
          await pipeline.exec();
        } catch (error) {
          console.warn('KV batch delete failed:', error);
        }
      });
    }

    // Clean up tracking maps
    entityIds.forEach(entityId => {
      const keys = this.dependencyMap.get(entityId) || new Set();
      keys.forEach(key => this.reverseMap.delete(key));
      this.dependencyMap.delete(entityId);
    });
  }

  trackDependencies(cacheKey, entityIds) {
    this.reverseMap.set(cacheKey, new Set(entityIds));
    
    entityIds.forEach(entityId => {
      if (!this.dependencyMap.has(entityId)) {
        this.dependencyMap.set(entityId, new Set());
      }
      this.dependencyMap.get(entityId).add(cacheKey);
    });
  }

  // Health check for all Redis connections
  async healthCheck() {
    try {
      const ping = await this.kvCache.ping();
      return { 
        status: 'healthy', 
        kvCache: ping === 'PONG' ? 'connected' : 'disconnected',
        memoryCache: {
          keys: memoryCache.keys().length,
          stats: memoryCache.getStats()
        }
      };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message 
      };
    }
  }
}
