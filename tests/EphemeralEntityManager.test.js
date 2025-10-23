// tests/EphemeralEntityManager.test.js

// Factory to create mock pipeline objects - each pipeline needs its own command counter
const createMockPipeline = () => {
  let commandCounter = 0;
  return {
    call: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    expire: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    set: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    del: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    incr: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    exec: jest.fn(),
    get length() {
      return commandCounter;
    }
  };
};

// Store pipeline mocks for each call
let pipelineMocks = [];

// Mock Redis
const mockRedis = {
  call: jest.fn(),
  pipeline: jest.fn(() => {
    const pipeline = createMockPipeline();
    pipelineMocks.push(pipeline);
    return pipeline;
  }),
  get: jest.fn(),
  set: jest.fn(),
  expire: jest.fn()
};

// Create mget mock that persists across clearAllMocks
const mockMget = jest.fn().mockResolvedValue([]);

// Mock StreamManager
const mockStreamManager = {
  batchAddToStreams: jest.fn(),
  getWorldInstanceKey: jest.fn((streamId) => `stream_world_instance:${streamId}`),
  redis: {
    mget: mockMget
  }
};

jest.mock('../config.js', () => ({
  ephemeralRedis: {
    call: jest.fn(),
    pipeline: jest.fn(() => ({
      call: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      incr: jest.fn().mockReturnThis(),
      exec: jest.fn()
    })),
    get: jest.fn(),
    set: jest.fn(),
    expire: jest.fn(),
    sadd: jest.fn(),
    spop: jest.fn(),
    scard: jest.fn()
  },
  config: {
    entityTypes: {
      persistent: ['Account', 'Guild', 'Alliance', 'Party', 'PlayerCharacter'],
      ephemeral: ['OnlineMapData', 'Channel', 'World']
    }
  }
}));

import { EphemeralEntityManager } from '../util/EphemeralEntityManager.js';

describe('EphemeralEntityManager', () => {
  let ephemeralManager;

  beforeEach(() => {
    pipelineMocks = [];
    jest.clearAllMocks();
    ephemeralManager = new EphemeralEntityManager(mockStreamManager);
    // Reset mget mock after clearAllMocks
    mockMget.mockResolvedValue([]);
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

      // Configure pipeline mocks before calling the method
      // The method will create 2 pipelines: existence check, main pipeline
      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const cachePipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return cachePipeline;
        }
      });

      // Mock existence check - entities don't exist
      existsPipeline.exec.mockResolvedValueOnce([[null, null], [null, null]]);

      // Mock main pipeline - JSON.SET + set version for each entity
      mainPipeline.exec.mockResolvedValueOnce([[null, 'OK'], [null, '1'], [null, 'OK'], [null, '1']]);

      // Mock cache pipeline (fire and forget)
      cachePipeline.exec.mockResolvedValueOnce([]);

      // Mock stream manager
      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([
        { success: true, version: 1 },
        { success: true, version: 1 }
      ]);

      // Verify JSON.SET calls for new entities
      expect(mainPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$',
        expect.stringContaining('"type":"ephemeral"')
      );

      // Note: Ephemeral entities don't set explicit TTL - they rely on Redis eviction policies
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

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const cachePipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return cachePipeline;
        }
      });

      // Mock existence check - entity exists
      existsPipeline.exec.mockResolvedValueOnce([[null, 'object']]);

      // Mock main pipeline
      mainPipeline.exec.mockResolvedValueOnce([
        [null, 'OK'], // JSON.SET level
        [null, 'OK'], // JSON.SET experience
        [null, 'OK'], // JSON.SET worldId
        [null, 'OK'], // JSON.SET lastWrite
        [null, 2],    // incr version
        [null, 'OK']  // JSON.SET version placeholder
      ]);

      cachePipeline.exec.mockResolvedValueOnce([]);
      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([{ success: true, version: 2 }]);

      // Verify JSON.SET calls for updating existing entity attributes
      expect(mainPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$.attributes.level',
        '11'
      );
      expect(mainPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$.attributes.experience',
        '1500'
      );
      expect(mainPipeline.call).toHaveBeenCalledWith(
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

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const cachePipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return cachePipeline;
        }
      });

      // Mock all entities as new
      const existsResults = Array.from({ length: 150 }, () => [null, null]);
      existsPipeline.exec.mockResolvedValueOnce(existsResults);

      // For each new entity: JSON.SET + set version = 2 commands per entity
      const mainPipelineResults = Array.from({ length: 150 }, () => [
        [null, 'OK'],  // JSON.SET
        [null, '1']    // set version
      ]).flat();
      mainPipeline.exec.mockResolvedValueOnce(mainPipelineResults);

      cachePipeline.exec.mockResolvedValue([]);
      mockStreamManager.batchAddToStreams.mockResolvedValue([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toHaveLength(150);
      expect(result.every(r => r.success)).toBe(true);

      // Should be called twice: once for exists check, once for main pipeline
      expect(existsPipeline.exec).toHaveBeenCalledTimes(1);
      expect(mainPipeline.exec).toHaveBeenCalledTimes(1);
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

      const existsPipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => existsPipeline);

      const error = new Error('Redis connection failed');
      existsPipeline.exec.mockRejectedValueOnce(error);

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

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const cachePipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return cachePipeline;
        }
      });

      existsPipeline.exec.mockResolvedValueOnce([[null, null]]);
      mainPipeline.exec.mockResolvedValueOnce([[null, 'OK'], [null, '1']]);
      cachePipeline.exec.mockResolvedValueOnce([]);

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

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const cachePipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return cachePipeline;
        }
      });

      existsPipeline.exec.mockResolvedValueOnce([[null, null]]);
      mainPipeline.exec.mockResolvedValueOnce([[null, 'OK'], [null, '1']]);
      cachePipeline.exec.mockResolvedValueOnce([]);

      // Mock stream manager failure
      mockStreamManager.batchAddToStreams.mockRejectedValueOnce(new Error('Stream failed'));

      const result = await ephemeralManager.batchSavePartial(updates);

      // Should still return success for the main save operation
      expect(result).toEqual([{ success: true, version: 1 }]);
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

      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);

      pipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEntity1)],
        [null, JSON.stringify(mockEntity2)]
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([
        { ...mockEntity1, worldInstanceId: '' },
        { ...mockEntity2, worldInstanceId: '' }
      ]);

      expect(pipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:player:1:user123');
      expect(pipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:session:1:sess456');
    });

    test('should handle non-existent entities', async () => {
      const requests = [
        { entityType: 'player', entityId: 'nonexistent', worldId: 1 }
      ];

      const pipeline = createMockPipeline();
      pipeline.exec.mockResolvedValueOnce([
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

      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);

      pipeline.exec.mockResolvedValueOnce([
        [new Error('Key access failed'), null], // First load fails
        [null, JSON.stringify(mockEntity)] // Second load succeeds
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null, { ...mockEntity, worldInstanceId: '' }]);
    });

    test('should handle Redis pipeline failure', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      const error = new Error('Pipeline execution failed');
      const pipeline = createMockPipeline();
      pipeline.exec.mockRejectedValueOnce(error);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null]);
    });

    test('should handle invalid JSON in Redis', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      const pipeline = createMockPipeline();
      pipeline.exec.mockResolvedValueOnce([
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

      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);

      pipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEntity1)], // exists
        [null, null], // doesn't exist
        [null, JSON.stringify(mockEntity3)] // exists
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([
        { ...mockEntity1, worldInstanceId: '' },
        null,
        { ...mockEntity3, worldInstanceId: '' }
      ]);
    });
  });
});