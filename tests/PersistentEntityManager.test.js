// Mock Prisma Client before importing anything
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    entity: {
      findMany: jest.fn()
    },
    $queryRaw: jest.fn()
  }))
}));

// Mock config to avoid Redis connection issues
jest.mock('../config.js', () => ({
  prisma: {
    entity: {
      findMany: jest.fn()
    },
    $queryRaw: jest.fn()
  }
}));

import { PersistentEntityManager } from '../util/PersistentEntityManager.js';

// Mock dependencies
const mockCache = {
  mget: jest.fn(),
  mset: jest.fn(),
  set: jest.fn(),
  get: jest.fn(),
  trackDependencies: jest.fn(),
  invalidateEntities: jest.fn(),
  defaultTTL: 300
};

const mockPrisma = {
  entity: {
    findMany: jest.fn()
  },
  $queryRaw: jest.fn()
};

// Create mget mock that persists across clearAllMocks
const mockMget = jest.fn().mockResolvedValue([]);

const mockStreamManager = {
  batchAddToStreams: jest.fn(),
  getWorldInstanceKey: jest.fn((streamId) => `stream_world_instance:${streamId}`),
  redis: {
    mget: mockMget
  }
};

describe('PersistentEntityManager', () => {
  let manager;

  beforeEach(() => {
    manager = new PersistentEntityManager(mockCache, mockStreamManager);
    manager.prisma = mockPrisma;
    jest.clearAllMocks();
    // Reset mget mock after clearAllMocks
    mockMget.mockResolvedValue([]);
  });

  describe('getCacheKey', () => {
    it('should generate correct cache key', () => {
      const key = manager.getCacheKey('character', 'user123', 1);
      expect(key).toBe('entity:character:1:user123');
    });

    it('should handle different entity types', () => {
      const key = manager.getCacheKey('guild', 'guild456', 2);
      expect(key).toBe('entity:guild:2:guild456');
    });

    it('should generate versioned cache key when version is provided', () => {
      const key = manager.getCacheKey('character', 'user123', 1, 5);
      expect(key).toBe('entity:character:1:user123:v5');
    });

    it('should generate non-versioned cache key when version is null', () => {
      const key = manager.getCacheKey('character', 'user123', 1, null);
      expect(key).toBe('entity:character:1:user123');
    });

    it('should generate non-versioned cache key when version is not provided', () => {
      const key = manager.getCacheKey('character', 'user123', 1);
      expect(key).toBe('entity:character:1:user123');
    });
  });

  describe('computeEntityDiff', () => {
    it('should return full entity when old entity is null', () => {
      const newEntity = {
        id: 'user1',
        attributes: { level: 10, exp: 100 },
        rankScores: { combat: 50 }
      };

      const diff = manager.computeEntityDiff(null, newEntity);

      expect(diff).toEqual(newEntity);
    });

    it('should return only changed attributes', () => {
      const oldEntity = {
        attributes: { level: 10, exp: 100, name: 'Player' },
        rankScores: { combat: 50 }
      };

      const newEntity = {
        attributes: { level: 11, exp: 150, name: 'Player' },
        rankScores: { combat: 50 }
      };

      const diff = manager.computeEntityDiff(oldEntity, newEntity);

      expect(diff.attributes).toEqual({ level: 11, exp: 150 });
      expect(diff.rankScores).toEqual({});
    });

    it('should mark deleted attributes with NULL_MARKER', () => {
      const oldEntity = {
        attributes: { level: 10, exp: 100, temp: 'data' },
        rankScores: {}
      };

      const newEntity = {
        attributes: { level: 10, exp: 100 },
        rankScores: {}
      };

      const diff = manager.computeEntityDiff(oldEntity, newEntity);

      expect(diff.attributes.temp).toBe('$$__NULL__$$');
    });

    it('should handle changed rank scores', () => {
      const oldEntity = {
        attributes: {},
        rankScores: { combat: 50, magic: 30 }
      };

      const newEntity = {
        attributes: {},
        rankScores: { combat: 60, magic: 30 }
      };

      const diff = manager.computeEntityDiff(oldEntity, newEntity);

      expect(diff.rankScores).toEqual({ combat: 60 });
    });

    it('should mark deleted rank scores with NULL_MARKER', () => {
      const oldEntity = {
        attributes: {},
        rankScores: { combat: 50, magic: 30 }
      };

      const newEntity = {
        attributes: {},
        rankScores: { combat: 50 }
      };

      const diff = manager.computeEntityDiff(oldEntity, newEntity);

      expect(diff.rankScores.magic).toBe('$$__NULL__$$');
    });

    it('should handle complex nested objects', () => {
      const oldEntity = {
        attributes: { config: { setting1: true, setting2: false } },
        rankScores: {}
      };

      const newEntity = {
        attributes: { config: { setting1: true, setting2: true } },
        rankScores: {}
      };

      const diff = manager.computeEntityDiff(oldEntity, newEntity);

      expect(diff.attributes.config).toEqual({ setting1: true, setting2: true });
    });
  });

  describe('batchLoad', () => {
    beforeEach(() => {
      // Mock setImmediate to execute immediately for testing
      global.setImmediate = jest.fn((callback) => callback());
    });

    it('should return empty array for empty requests', async () => {
      const result = await manager.batchLoad([]);
      expect(result).toEqual([]);
    });

    it('should return cached entities when available', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1 },
        { entityType: 'character', entityId: 'user2', worldId: 1 }
      ];

      const cachedEntities = new Map([
        ['entity:character:1:user1', { id: 'user1', name: 'Player1' }],
        ['entity:character:1:user2', { id: 'user2', name: 'Player2' }]
      ]);

      mockCache.mget.mockResolvedValue(cachedEntities);

      const result = await manager.batchLoad(requests);

      expect(result).toEqual([
        { id: 'user1', name: 'Player1', worldInstanceId: '' },
        { id: 'user2', name: 'Player2', worldInstanceId: '' }
      ]);
      expect(mockCache.mget).toHaveBeenCalledWith([
        'entity:character:1:user1',
        'entity:character:1:user2'
      ]);
    });

    it('should load from database when cache misses', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1 }
      ];

      mockCache.mget.mockResolvedValue(new Map());
      mockPrisma.entity.findMany.mockResolvedValue([
        { id: 'user1', entityType: 'character', worldId: 1, name: 'Player1' }
      ]);

      const result = await manager.batchLoad(requests);

      expect(result).toEqual([
        { id: 'user1', entityType: 'character', worldId: 1, name: 'Player1', worldInstanceId: '' }
      ]);
      expect(mockPrisma.entity.findMany).toHaveBeenCalledWith({
        where: {
          entityType: 'character',
          id: { in: ['user1'] },
          worldId: 1,
          isDeleted: false
        }
      });
    });

    it('should handle database errors gracefully', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1 }
      ];

      mockCache.mget.mockResolvedValue(new Map());
      mockPrisma.entity.findMany.mockRejectedValue(new Error('DB Error'));

      const result = await manager.batchLoad(requests);

      expect(result).toEqual(['$$__NULL__$$']);
    });

    it('should handle versioned loads with version parameter', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1, version: 5 }
      ];

      const versionedEntity = {
        id: 'user1',
        version: 5,
        attributes: { level: 10 },
        rankScores: {}
      };

      const newestEntity = {
        id: 'user1',
        version: 7,
        attributes: { level: 12, exp: 100 },
        rankScores: {}
      };

      // Mock cache to return both versioned and newest entities
      mockCache.mget.mockResolvedValue(new Map([
        ['entity:character:1:user1:v5', versionedEntity],
        ['entity:character:1:user1', newestEntity]
      ]));

      const result = await manager.batchLoad(requests);

      expect(result).toHaveLength(1);
      // Should return diff: only changed attributes (level and exp)
      expect(result[0].attributes).toEqual({ level: 12, exp: 100 });
      expect(mockCache.mget).toHaveBeenCalledWith([
        'entity:character:1:user1',
        'entity:character:1:user1:v5'
      ]);
    });

    it('should load from database and compute diff for versioned requests', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1, version: 3 }
      ];

      const versionedEntity = {
        id: 'user1',
        version: 3,
        attributes: { level: 8 },
        rankScores: {}
      };

      const newestEntity = {
        id: 'user1',
        entityType: 'character',
        worldId: 1,
        version: 5,
        attributes: { level: 10, exp: 50 },
        rankScores: {}
      };

      // Cache has versioned entity but not newest
      mockCache.mget.mockResolvedValue(new Map([
        ['entity:character:1:user1:v3', versionedEntity]
      ]));

      mockPrisma.entity.findMany.mockResolvedValue([newestEntity]);

      const result = await manager.batchLoad(requests);

      expect(result).toHaveLength(1);
      // Should return diff
      expect(result[0].attributes).toEqual({ level: 10, exp: 50 });
      expect(mockPrisma.entity.findMany).toHaveBeenCalled();
    });

    it('should cache both newest and versioned entities after loading', async () => {
      const requests = [
        { entityType: 'character', entityId: 'user1', worldId: 1 }
      ];

      mockCache.mget.mockResolvedValue(new Map());
      mockPrisma.entity.findMany.mockResolvedValue([
        {
          id: 'user1',
          entityType: 'character',
          worldId: 1,
          version: 5,
          attributes: { level: 10 }
        }
      ]);

      await manager.batchLoad(requests);

      // Should cache both newest and versioned
      expect(mockCache.mset).toHaveBeenCalledWith(
        expect.arrayContaining([
          ['entity:character:1:user1', expect.any(Object)],
          ['entity:character:1:user1:v5', expect.any(Object)]
        ]),
        300
      );
    });
  });

  describe('batchSavePartial', () => {
    beforeEach(() => {
      // Mock setImmediate to execute immediately for testing
      global.setImmediate = jest.fn((callback) => callback());
    });

    afterEach(() => {
      global.setImmediate = setImmediate;
    });

    it('should return empty array for empty updates', async () => {
      const result = await manager.batchSavePartial([]);
      expect(result).toEqual([]);
    });

    it('should merge multiple updates for same entity', async () => {
      const updates = [
        { entityType: 'character', entityId: 'user1', worldId: 1, attributes: { level: 10 } },
        { entityType: 'character', entityId: 'user1', worldId: 1, attributes: { exp: 100 } }
      ];

      const result = await manager.batchSavePartial(updates);

      expect(result).toEqual([
        { success: true },
        { success: true }
      ]);
    });

    it('should call performBatchUpsert with merged updates', async () => {
      const updates = [
        { entityType: 'character', entityId: 'user1', worldId: 1, attributes: { level: 10 } }
      ];

      const performBatchUpsertSpy = jest.spyOn(manager, 'performBatchUpsert').mockResolvedValue();

      await manager.batchSavePartial(updates);

      // Wait for setImmediate to execute
      await new Promise(resolve => process.nextTick(resolve));

      expect(performBatchUpsertSpy).toHaveBeenCalledWith(expect.any(Map));
    });
  });

  describe('performBatchUpsert', () => {
    beforeEach(() => {
      global.setImmediate = jest.fn((callback) => callback());
    });

    afterEach(() => {
      global.setImmediate = setImmediate;
    });

    it('should execute batch upsert and invalidate cache', async () => {
      const mergedUpdates = new Map([
        ['character:user1:1', {
          entityType: 'character',
          entityId: 'user1',
          worldId: 1,
          attributes: { level: 10 },
          rankScores: {}
        }]
      ]);

      mockPrisma.$queryRaw.mockResolvedValue(undefined);
      mockCache.invalidateEntities.mockResolvedValue();
      mockStreamManager.batchAddToStreams.mockResolvedValue();

      await manager.performBatchUpsert(mergedUpdates);

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockCache.invalidateEntities).toHaveBeenCalledWith(['character:user1']);
    });
  });

  describe('batchGetRankedEntities', () => {
    it('should return empty array for empty requests', async () => {
      const result = await manager.batchGetRankedEntities([]);
      expect(result).toEqual([]);
    });

    it('should batch cache gets and return cached values', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, rankKey: 'level', sortOrder: 'DESC', limit: 100 },
        { entityType: 'character', worldId: 1, rankKey: 'power', sortOrder: 'ASC', limit: 50 }
      ];

      const cacheResults = new Map([
        ['rankings:character:1:level:DESC:100', [{ id: 'user1', score: 1000 }]],
        ['rankings:character:1:power:ASC:50', [{ id: 'user2', power: 500 }]]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);

      const result = await manager.batchGetRankedEntities(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', score: 1000 }]);
      expect(result[1]).toEqual([{ id: 'user2', power: 500 }]);
      expect(mockCache.mget).toHaveBeenCalledWith([
        'rankings:character:1:level:DESC:100',
        'rankings:character:1:power:ASC:50'
      ]);
    });

    it('should handle cache misses and batch database queries', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, rankKey: 'level' },
        { entityType: 'character', worldId: 1, rankKey: 'power' }
      ];

      const cacheResults = new Map();
      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'user1', score: 1000 }])
        .mockResolvedValueOnce([{ id: 'user2', power: 500 }]);

      const result = await manager.batchGetRankedEntities(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', score: 1000 }]);
      expect(result[1]).toEqual([{ id: 'user2', power: 500 }]);
      expect(mockCache.mset).toHaveBeenCalled();
    });

    it('should mix cached and non-cached results', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, rankKey: 'level' },
        { entityType: 'character', worldId: 1, rankKey: 'power' }
      ];

      const cacheResults = new Map([
        ['rankings:character:1:level:DESC:100', [{ id: 'user1', score: 1000 }]]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'user2', power: 500 }]);

      const result = await manager.batchGetRankedEntities(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', score: 1000 }]);
      expect(result[1]).toEqual([{ id: 'user2', power: 500 }]);
    });
  });

  describe('batchSearchByName', () => {
    it('should return empty array for empty requests', async () => {
      const result = await manager.batchSearchByName([]);
      expect(result).toEqual([]);
    });

    it('should batch cache gets and return cached values', async () => {
      const requests = [
        { entityType: 'character', namePattern: 'John%', worldId: 1, limit: 100 },
        { entityType: 'character', namePattern: 'Jane%', worldId: 1, limit: 50 }
      ];

      const cacheResults = new Map([
        ['search:character:1:John%:100', [{ id: 'user1', name: 'John' }]],
        ['search:character:1:Jane%:50', [{ id: 'user2', name: 'Jane' }]]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);

      const result = await manager.batchSearchByName(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', name: 'John' }]);
      expect(result[1]).toEqual([{ id: 'user2', name: 'Jane' }]);
      expect(mockCache.mget).toHaveBeenCalledWith([
        'search:character:1:John%:100',
        'search:character:1:Jane%:50'
      ]);
    });

    it('should handle cache misses and batch database queries', async () => {
      const requests = [
        { entityType: 'character', namePattern: 'John%', worldId: 1 },
        { entityType: 'character', namePattern: 'Jane%', worldId: 1 }
      ];

      const cacheResults = new Map();
      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'user1', name: 'John' }])
        .mockResolvedValueOnce([{ id: 'user2', name: 'Jane' }]);

      const result = await manager.batchSearchByName(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', name: 'John' }]);
      expect(result[1]).toEqual([{ id: 'user2', name: 'Jane' }]);
      expect(mockCache.mset).toHaveBeenCalled();
    });

    it('should mix cached and non-cached results', async () => {
      const requests = [
        { entityType: 'character', namePattern: 'John%', worldId: 1 },
        { entityType: 'character', namePattern: 'Jane%', worldId: 1 }
      ];

      const cacheResults = new Map([
        ['search:character:1:John%:100', [{ id: 'user1', name: 'John' }]]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'user2', name: 'Jane' }]);

      const result = await manager.batchSearchByName(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([{ id: 'user1', name: 'John' }]);
      expect(result[1]).toEqual([{ id: 'user2', name: 'Jane' }]);
    });
  });

  describe('batchCalculateEntityRank', () => {
    it('should return empty array for empty requests', async () => {
      const result = await manager.batchCalculateEntityRank([]);
      expect(result).toEqual([]);
    });

    it('should batch cache gets and return cached values', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, entityId: 'user1', rankKey: 'level' },
        { entityType: 'character', worldId: 1, entityId: 'user2', rankKey: 'level' }
      ];

      const cacheResults = new Map([
        ['rank:character:1:user1:level', { rank: 1, score: 1000 }],
        ['rank:character:1:user2:level', { rank: 2, score: 900 }]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);

      const result = await manager.batchCalculateEntityRank(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ rank: 1, score: 1000 });
      expect(result[1]).toEqual({ rank: 2, score: 900 });
      expect(mockCache.mget).toHaveBeenCalledWith([
        'rank:character:1:user1:level',
        'rank:character:1:user2:level'
      ]);
    });

    it('should handle cache misses and batch database queries', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, entityId: 'user1', rankKey: 'level' },
        { entityType: 'character', worldId: 1, entityId: 'user2', rankKey: 'level' }
      ];

      const cacheResults = new Map();
      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ score: 1000, rank: 1, total_entities: 100 }])
        .mockResolvedValueOnce([{ score: 900, rank: 2, total_entities: 100 }]);

      const result = await manager.batchCalculateEntityRank(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ rank: 1, score: 1000 });
      expect(result[1]).toMatchObject({ rank: 2, score: 900 });
      expect(mockCache.mset).toHaveBeenCalled();
    });

    it('should mix cached and non-cached results', async () => {
      const requests = [
        { entityType: 'character', worldId: 1, entityId: 'user1', rankKey: 'level' },
        { entityType: 'character', worldId: 1, entityId: 'user2', rankKey: 'level' }
      ];

      const cacheResults = new Map([
        ['rank:character:1:user1:level', { rank: 1, score: 1000 }]
      ]);

      mockCache.mget.mockResolvedValue(cacheResults);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ score: 900, rank: 2, total_entities: 100 }]);

      const result = await manager.batchCalculateEntityRank(requests);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ rank: 1, score: 1000 });
      expect(result[1]).toMatchObject({ rank: 2, score: 900 });
    });
  });

});
