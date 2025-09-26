// tests/EphemeralEntityManager.test.js

// Mock pipeline object
const mockPipeline = {
  call: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn()
};

// Mock Redis
const mockRedis = {
  call: jest.fn(),
  pipeline: jest.fn(() => mockPipeline),
  get: jest.fn(),
  set: jest.fn(),
  expire: jest.fn()
};

// Mock StreamManager
const mockStreamManager = {
  batchAddToStreams: jest.fn()
};

jest.mock('../cloud/config.js', () => ({
  ephemeralRedis: {
    call: jest.fn(),
    pipeline: jest.fn(() => ({
      call: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn()
    })),
    get: jest.fn(),
    set: jest.fn(),
    expire: jest.fn()
  }
}));

import { EphemeralEntityManager } from '../cloud/util/EphemeralEntityManager.js';

describe('EphemeralEntityManager', () => {
  let ephemeralManager;

  beforeEach(() => {
    ephemeralManager = new EphemeralEntityManager(mockStreamManager);
    jest.clearAllMocks();
    ephemeralManager.redis.pipeline.mockReturnValue(mockPipeline);
  });

  describe('constructor', () => {
    test('should initialize with correct properties', () => {
      expect(ephemeralManager.redis).toBeDefined();
      expect(ephemeralManager.streamManager).toBe(mockStreamManager);
    });

    test('should check RedisJSON support on initialization', async () => {
      // Mock successful RedisJSON support check
      ephemeralManager.redis.call
        .mockResolvedValueOnce('OK') // JSON.SET
        .mockResolvedValueOnce(1); // JSON.DEL

      const manager = new EphemeralEntityManager(mockStreamManager);
      await manager.checkRedisJSONSupport();

      expect(manager.redis.call).toHaveBeenCalledWith('JSON.SET', 'test:support', '$', JSON.stringify({ test: true }));
      expect(manager.redis.call).toHaveBeenCalledWith('JSON.DEL', 'test:support');
    });

    test('should throw error when RedisJSON is not available', async () => {
      ephemeralManager.redis.call.mockRejectedValueOnce(new Error('Unknown command JSON.SET'));

      await expect(ephemeralManager.checkRedisJSONSupport()).rejects.toThrow(
        'RedisJSON module required for ephemeral entity operations'
      );
    });
  });

  describe('getEphemeralKey', () => {
    test('should generate correct ephemeral key', () => {
      const key = ephemeralManager.getEphemeralKey('player', 'user123', 1);
      expect(key).toBe('ephemeral:player:1:user123');
    });

    test('should handle different entity types and world IDs', () => {
      const key1 = ephemeralManager.getEphemeralKey('session', 'abc456', 999);
      const key2 = ephemeralManager.getEphemeralKey('temp_data', 'xyz789', 0);
      
      expect(key1).toBe('ephemeral:session:999:abc456');
      expect(key2).toBe('ephemeral:temp_data:0:xyz789');
    });
  });

  describe('batchSavePartial', () => {
    test('should handle empty array', async () => {
      const result = await ephemeralManager.batchSavePartial([]);
      expect(result).toEqual([]);
      expect(ephemeralManager.redis.pipeline).not.toHaveBeenCalled();
    });

    test('should successfully save new entities', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 10, gold: 500 }
        },
        {
          entityType: 'session',
          entityId: 'sess456',
          worldId: 1,
          attributes: { lastActive: '2023-01-01' }
        }
      ];

      // Mock existence check - entities don't exist
      mockPipeline.exec
        .mockResolvedValueOnce([[null, null], [null, null]]) // existence check
        .mockResolvedValueOnce([]); // main pipeline

      // Mock stream manager
      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([
        { success: true },
        { success: true }
      ]);

      // Verify JSON.SET calls for new entities
      expect(mockPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$',
        expect.stringContaining('"type":"ephemeral"')
      );

      expect(mockPipeline.expire).toHaveBeenCalledWith('ephemeral:player:1:user123', 300);
      expect(mockPipeline.expire).toHaveBeenCalledWith('ephemeral:session:1:sess456', 300);
    });

    test('should successfully update existing entities', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 11, experience: 1500 }
        }
      ];

      // Mock existence check - entity exists
      mockPipeline.exec
        .mockResolvedValueOnce([[null, 'object']]) // existence check - entity exists
        .mockResolvedValueOnce([]); // main pipeline

      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([{ success: true }]);

      // Verify JSON.SET calls for updating existing entity attributes
      expect(mockPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$.attributes.level',
        '11'
      );
      expect(mockPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$.attributes.experience',
        '1500'
      );
      expect(mockPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$.worldId',
        1
      );
    });

    test('should batch process large numbers of updates', async () => {
      // Create 150 updates to test batching
      const updates = Array.from({ length: 150 }, (_, i) => ({
        entityType: 'player',
        entityId: `user${i}`,
        worldId: 1,
        attributes: { level: i + 1 }
      }));

      // Mock all entities as new
      const existsResults = Array.from({ length: 150 }, () => [null, null]);
      mockPipeline.exec
        .mockResolvedValueOnce(existsResults) // existence check
        .mockResolvedValueOnce([]) // first batch
        .mockResolvedValueOnce([]); // second batch

      mockStreamManager.batchAddToStreams.mockResolvedValue([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toHaveLength(150);
      expect(result.every(r => r.success)).toBe(true);

      // Should be called twice due to batch size of 100
      expect(mockPipeline.exec).toHaveBeenCalledTimes(3); // 1 for exists + 2 for batches
    });

    test('should handle Redis errors gracefully', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 10 }
        }
      ];

      const error = new Error('Redis connection failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([
        { success: false, error: 'Redis connection failed' }
      ]);
    });

    test('should trigger stream updates for saved entities', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 10, gold: 500 }
        }
      ];

      mockPipeline.exec
        .mockResolvedValueOnce([[null, null]]) // existence check
        .mockResolvedValueOnce([]); // main pipeline

      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      await ephemeralManager.batchSavePartial(updates);

      // Wait for the setImmediate callback to execute
      await new Promise(resolve => setImmediate(resolve));

      // Verify stream manager is called with correct data
      expect(mockStreamManager.batchAddToStreams).toHaveBeenCalledWith([
        {
          streamId: 'ephemeral:player:1:user123',
          data: { level: 10, gold: 500 }
        }
      ]);
    });

    test('should handle stream update failures gracefully', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 10 }
        }
      ];

      mockPipeline.exec
        .mockResolvedValueOnce([[null, null]]) // existence check
        .mockResolvedValueOnce([]); // main pipeline

      // Mock stream manager failure
      mockStreamManager.batchAddToStreams.mockRejectedValueOnce(new Error('Stream failed'));

      const result = await ephemeralManager.batchSavePartial(updates);

      // Should still return success for the main save operation
      expect(result).toEqual([{ success: true }]);
    });
  });

  describe('batchLoad', () => {
    test('should handle empty array', async () => {
      const result = await ephemeralManager.batchLoad([]);
      expect(result).toEqual([]);
      expect(ephemeralManager.redis.pipeline).not.toHaveBeenCalled();
    });

    test('should successfully load existing entities', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 },
        { entityType: 'session', entityId: 'sess456', worldId: 1 }
      ];

      const mockEntity1 = {
        id: 'user123',
        entityType: 'player',
        worldId: 1,
        attributes: { level: 10, gold: 500 },
        type: 'ephemeral'
      };

      const mockEntity2 = {
        id: 'sess456',
        entityType: 'session',
        worldId: 1,
        attributes: { lastActive: '2023-01-01' },
        type: 'ephemeral'
      };

      mockPipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEntity1)],
        [null, JSON.stringify(mockEntity2)]
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([mockEntity1, mockEntity2]);

      expect(mockPipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:player:1:user123');
      expect(mockPipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:session:1:sess456');
    });

    test('should handle non-existent entities', async () => {
      const requests = [
        { entityType: 'player', entityId: 'nonexistent', worldId: 1 }
      ];

      mockPipeline.exec.mockResolvedValueOnce([
        [null, null] // Entity doesn't exist
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null]);
    });

    test('should handle Redis errors in individual loads', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 },
        { entityType: 'player', entityId: 'user456', worldId: 1 }
      ];

      const mockEntity = {
        id: 'user456',
        entityType: 'player',
        worldId: 1,
        attributes: { level: 5 }
      };

      mockPipeline.exec.mockResolvedValueOnce([
        [new Error('Key access failed'), null], // First load fails
        [null, JSON.stringify(mockEntity)] // Second load succeeds
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null, mockEntity]);
    });

    test('should handle Redis pipeline failure', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      const error = new Error('Pipeline execution failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null]);
    });

    test('should handle invalid JSON in Redis', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      mockPipeline.exec.mockResolvedValueOnce([
        [null, 'invalid json string']
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null]);
    });

    test('should load multiple entities with mixed results', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 },
        { entityType: 'player', entityId: 'nonexistent', worldId: 1 },
        { entityType: 'session', entityId: 'sess789', worldId: 2 }
      ];

      const mockEntity1 = { id: 'user123', entityType: 'player', worldId: 1, attributes: { level: 10 } };
      const mockEntity3 = { id: 'sess789', entityType: 'session', worldId: 2, attributes: { active: true } };

      mockPipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEntity1)], // exists
        [null, null], // doesn't exist
        [null, JSON.stringify(mockEntity3)] // exists
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([mockEntity1, null, mockEntity3]);
    });
  });
});