const { HybridCacheManager } = require('../cloud/util/HybridCacheManager');

// Mock the config module
jest.mock('../cloud/config.js', () => ({
  memoryCache: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    keys: jest.fn().mockReturnValue([]),
    getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0 })
  },
  cacheRedis: {
    get: jest.fn(),
    setex: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(),
    del: jest.fn(),
    ping: jest.fn()
  }
}));

const { memoryCache, cacheRedis } = require('../cloud/config.js');

// Mock pipeline for Redis batch operations
const mockPipeline = {
  setex: jest.fn().mockReturnThis(),
  del: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
};

describe('HybridCacheManager', () => {
  let hybridManager;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Setup pipeline mock
    cacheRedis.pipeline.mockReturnValue(mockPipeline);
    
    hybridManager = new HybridCacheManager();
  });

  describe('constructor', () => {
    test('should initialize with dependency tracking maps', () => {
      expect(hybridManager.dependencyMap).toBeInstanceOf(Map);
      expect(hybridManager.reverseMap).toBeInstanceOf(Map);
      expect(hybridManager.kvCache).toBe(cacheRedis);
    });
  });

  describe('get', () => {
    const testKey = 'test:key';
    const testValue = { name: 'test', value: 42 };

    test('should return data from memory cache (L1) when available', async () => {
      memoryCache.get.mockReturnValue(testValue);

      const result = await hybridManager.get(testKey);

      expect(memoryCache.get).toHaveBeenCalledWith(testKey);
      expect(result).toEqual(testValue);
      expect(cacheRedis.get).not.toHaveBeenCalled();
    });

    test('should fallback to KV cache (L2) when memory cache misses', async () => {
      memoryCache.get.mockReturnValue(undefined);
      cacheRedis.get.mockResolvedValue(JSON.stringify(testValue));

      const result = await hybridManager.get(testKey);

      expect(memoryCache.get).toHaveBeenCalledWith(testKey);
      expect(cacheRedis.get).toHaveBeenCalledWith(testKey);
      expect(memoryCache.set).toHaveBeenCalledWith(testKey, testValue, 300);
      expect(result).toEqual(testValue);
    });

    test('should return null when both caches miss', async () => {
      memoryCache.get.mockReturnValue(undefined);
      cacheRedis.get.mockResolvedValue(null);

      const result = await hybridManager.get(testKey);

      expect(result).toBeNull();
    });

    test('should handle KV cache errors gracefully', async () => {
      memoryCache.get.mockReturnValue(undefined);
      cacheRedis.get.mockRejectedValue(new Error('Redis connection failed'));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await hybridManager.get(testKey);

      expect(consoleSpy).toHaveBeenCalledWith('KV cache miss:', 'Redis connection failed');
      expect(result).toBeNull();

      consoleSpy.mockRestore();
    });

    test('should handle JSON parsing errors gracefully', async () => {
      memoryCache.get.mockReturnValue(undefined);
      cacheRedis.get.mockResolvedValue('invalid json');

      const result = await hybridManager.get(testKey);

      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    const testKey = 'test:key';
    const testValue = { name: 'test', value: 42 };
    const testTTL = 600;
    const testDependencies = ['entity1', 'entity2'];

    test('should set data in memory cache immediately', async () => {
      await hybridManager.set(testKey, testValue);

      expect(memoryCache.set).toHaveBeenCalledWith(testKey, testValue, 300);
    });

    test('should use custom TTL when provided', async () => {
      await hybridManager.set(testKey, testValue, testTTL);

      expect(memoryCache.set).toHaveBeenCalledWith(testKey, testValue, testTTL);
    });

    test('should track dependencies when provided', async () => {
      await hybridManager.set(testKey, testValue, testTTL, testDependencies);

      expect(hybridManager.reverseMap.get(testKey)).toEqual(new Set(testDependencies));
      expect(hybridManager.dependencyMap.get('entity1')).toEqual(new Set([testKey]));
      expect(hybridManager.dependencyMap.get('entity2')).toEqual(new Set([testKey]));
    });

    test('should async write to KV cache', (done) => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      hybridManager.set(testKey, testValue, testTTL);

      // Use setImmediate to wait for the async KV write
      setImmediate(() => {
        setImmediate(() => {
          expect(cacheRedis.setex).toHaveBeenCalledWith(testKey, testTTL, JSON.stringify(testValue));
          consoleSpy.mockRestore();
          done();
        });
      });
    });
  });

  describe('mget', () => {
    const keys = ['key1', 'key2', 'key3'];
    const values = [
      { id: 1, name: 'test1' },
      { id: 2, name: 'test2' },
      { id: 3, name: 'test3' }
    ];

    test('should return results from memory cache when available', async () => {
      memoryCache.get.mockImplementation(key => {
        const index = keys.indexOf(key);
        return index !== -1 ? values[index] : undefined;
      });

      const result = await hybridManager.mget(keys);

      expect(result.size).toBe(3);
      expect(result.get('key1')).toEqual(values[0]);
      expect(result.get('key2')).toEqual(values[1]);
      expect(result.get('key3')).toEqual(values[2]);
      expect(cacheRedis.mget).not.toHaveBeenCalled();
    });

    test('should fetch missing keys from KV cache', async () => {
      memoryCache.get.mockImplementation(key => {
        return key === 'key1' ? values[0] : undefined;
      });
      
      cacheRedis.mget.mockResolvedValue([
        JSON.stringify(values[1]),
        JSON.stringify(values[2])
      ]);

      const result = await hybridManager.mget(keys);

      expect(cacheRedis.mget).toHaveBeenCalledWith('key2', 'key3');
      expect(result.size).toBe(3);
      expect(result.get('key1')).toEqual(values[0]);
      expect(result.get('key2')).toEqual(values[1]);
      expect(result.get('key3')).toEqual(values[2]);
      
      // Should promote KV results to memory cache
      expect(memoryCache.set).toHaveBeenCalledWith('key2', values[1], 300);
      expect(memoryCache.set).toHaveBeenCalledWith('key3', values[2], 300);
    });

    test('should handle KV batch get errors gracefully', async () => {
      memoryCache.get.mockReturnValue(undefined);
      cacheRedis.mget.mockRejectedValue(new Error('Batch get failed'));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await hybridManager.mget(keys);

      expect(consoleSpy).toHaveBeenCalledWith('KV batch get failed:', 'Batch get failed');
      expect(result.size).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('mset', () => {
    const entries = [
      ['key1', { id: 1, name: 'test1' }],
      ['key2', { id: 2, name: 'test2' }]
    ];
    const testTTL = 600;

    test('should set all entries in memory cache immediately', async () => {
      await hybridManager.mset(entries, testTTL);

      expect(memoryCache.set).toHaveBeenCalledWith('key1', { id: 1, name: 'test1' }, testTTL);
      expect(memoryCache.set).toHaveBeenCalledWith('key2', { id: 2, name: 'test2' }, testTTL);
    });

    test('should use default TTL when not provided', async () => {
      await hybridManager.mset(entries);

      expect(memoryCache.set).toHaveBeenCalledWith('key1', { id: 1, name: 'test1' }, 300);
      expect(memoryCache.set).toHaveBeenCalledWith('key2', { id: 2, name: 'test2' }, 300);
    });

    test('should batch set in KV cache using pipeline', (done) => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      hybridManager.mset(entries, testTTL);

      setImmediate(() => {
        setImmediate(() => {
          expect(cacheRedis.pipeline).toHaveBeenCalled();
          expect(mockPipeline.setex).toHaveBeenCalledWith('key1', testTTL, JSON.stringify({ id: 1, name: 'test1' }));
          expect(mockPipeline.setex).toHaveBeenCalledWith('key2', testTTL, JSON.stringify({ id: 2, name: 'test2' }));
          expect(mockPipeline.exec).toHaveBeenCalled();
          consoleSpy.mockRestore();
          done();
        });
      });
    });
  });

  describe('invalidateEntity', () => {
    const entityId = 'entity123';
    const cacheKeys = ['key1', 'key2', 'key3'];

    beforeEach(() => {
      // Setup dependency tracking
      hybridManager.dependencyMap.set(entityId, new Set(cacheKeys));
      cacheKeys.forEach(key => {
        hybridManager.reverseMap.set(key, new Set([entityId]));
      });
    });

    test('should remove all dependent keys from memory cache', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await hybridManager.invalidateEntity(entityId);

      expect(consoleSpy).toHaveBeenCalledWith(`Invalidating ${cacheKeys.length} cache entries for entity ${entityId}`);
      
      cacheKeys.forEach(key => {
        expect(memoryCache.del).toHaveBeenCalledWith(key);
      });

      consoleSpy.mockRestore();
    });

    test('should batch remove from KV cache using pipeline', (done) => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      hybridManager.invalidateEntity(entityId);

      setImmediate(() => {
        setImmediate(() => {
          expect(cacheRedis.pipeline).toHaveBeenCalled();
          cacheKeys.forEach(key => {
            expect(mockPipeline.del).toHaveBeenCalledWith(key);
          });
          expect(mockPipeline.exec).toHaveBeenCalled();
          consoleSpy.mockRestore();
          done();
        });
      });
    });

    test('should clean up tracking maps', async () => {
      await hybridManager.invalidateEntity(entityId);

      expect(hybridManager.dependencyMap.has(entityId)).toBe(false);
      cacheKeys.forEach(key => {
        expect(hybridManager.reverseMap.has(key)).toBe(false);
      });
    });

    test('should handle entity with no dependencies', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await hybridManager.invalidateEntity('nonexistent');

      expect(consoleSpy).toHaveBeenCalledWith(`Invalidating 0 cache entries for entity nonexistent`);
      consoleSpy.mockRestore();
    });
  });

  describe('invalidateEntities', () => {
    const entityIds = ['entity1', 'entity2'];
    const entity1Keys = ['key1', 'key2'];
    const entity2Keys = ['key2', 'key3'];

    beforeEach(() => {
      hybridManager.dependencyMap.set('entity1', new Set(entity1Keys));
      hybridManager.dependencyMap.set('entity2', new Set(entity2Keys));
      
      hybridManager.reverseMap.set('key1', new Set(['entity1']));
      hybridManager.reverseMap.set('key2', new Set(['entity1', 'entity2']));
      hybridManager.reverseMap.set('key3', new Set(['entity2']));
    });

    test('should batch invalidate all dependent keys', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await hybridManager.invalidateEntities(entityIds);

      expect(consoleSpy).toHaveBeenCalledWith(`Batch invalidating 3 cache entries for 2 entities`);
      
      // Should remove all unique keys
      expect(memoryCache.del).toHaveBeenCalledWith('key1');
      expect(memoryCache.del).toHaveBeenCalledWith('key2');
      expect(memoryCache.del).toHaveBeenCalledWith('key3');

      consoleSpy.mockRestore();
    });

    test('should clean up all tracking maps', async () => {
      await hybridManager.invalidateEntities(entityIds);

      expect(hybridManager.dependencyMap.has('entity1')).toBe(false);
      expect(hybridManager.dependencyMap.has('entity2')).toBe(false);
      expect(hybridManager.reverseMap.has('key1')).toBe(false);
      expect(hybridManager.reverseMap.has('key2')).toBe(false);
      expect(hybridManager.reverseMap.has('key3')).toBe(false);
    });
  });

  describe('trackDependencies', () => {
    const cacheKey = 'test:key';
    const entityIds = ['entity1', 'entity2'];

    test('should setup bidirectional dependency tracking', () => {
      hybridManager.trackDependencies(cacheKey, entityIds);

      expect(hybridManager.reverseMap.get(cacheKey)).toEqual(new Set(entityIds));
      expect(hybridManager.dependencyMap.get('entity1')).toEqual(new Set([cacheKey]));
      expect(hybridManager.dependencyMap.get('entity2')).toEqual(new Set([cacheKey]));
    });

    test('should add to existing entity dependencies', () => {
      // Setup existing dependency
      hybridManager.dependencyMap.set('entity1', new Set(['existing:key']));

      hybridManager.trackDependencies(cacheKey, entityIds);

      expect(hybridManager.dependencyMap.get('entity1')).toEqual(new Set(['existing:key', cacheKey]));
    });
  });

  describe('healthCheck', () => {
    test('should return healthy status when KV cache is connected', async () => {
      cacheRedis.ping.mockResolvedValue('PONG');
      memoryCache.keys.mockReturnValue(['key1', 'key2']);
      memoryCache.getStats.mockReturnValue({ hits: 10, misses: 2 });

      const result = await hybridManager.healthCheck();

      expect(result).toEqual({
        status: 'healthy',
        kvCache: 'connected',
        memoryCache: {
          keys: 2,
          stats: { hits: 10, misses: 2 }
        }
      });
    });

    test('should return disconnected status when KV cache ping fails', async () => {
      cacheRedis.ping.mockResolvedValue('ERROR');

      const result = await hybridManager.healthCheck();

      expect(result.kvCache).toBe('disconnected');
    });

    test('should return unhealthy status when KV cache throws error', async () => {
      cacheRedis.ping.mockRejectedValue(new Error('Connection failed'));

      const result = await hybridManager.healthCheck();

      expect(result).toEqual({
        status: 'unhealthy',
        error: 'Connection failed'
      });
    });
  });
});