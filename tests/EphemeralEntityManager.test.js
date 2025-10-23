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
    sadd: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    srem: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    get: jest.fn(function() {
      commandCounter++;
      return this;
    }),
    eval: jest.fn(function() {
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
      sadd: jest.fn().mockReturnThis(),
      srem: jest.fn().mockReturnThis(),
      get: jest.fn().mockReturnThis(),
      exec: jest.fn()
    })),
    get: jest.fn(),
    set: jest.fn(),
    expire: jest.fn(),
    sadd: jest.fn(),
    srandmember: jest.fn(),
    srem: jest.fn(),
    scard: jest.fn()
  },
  config: {
    entityTypes: {
      persistent: ['Account', 'Guild', 'Alliance', 'Party', 'PlayerCharacter'],
      ephemeral: ['OnlineMapData', 'Channel', 'World']
    },
    ephemeral: {
      versionCacheTTL: 3600,
      batchSize: 5000
    },
    backgroundPersistence: {
      lockTTL: 10,
      batchSize: 500,
      intervalMs: 5000,
      maxRetries: 3,
      retryDelayMs: 1000
    },
    persistent: {
      batchSize: 5000
    },
    stream: {
      worldInstanceTTL: 3
    },
    lock: {
      defaultTTL: 10,
      retryDelayMs: 100,
      maxRetries: 3
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
          attributes: { level: 10, gold: 500 },
          isCreate: true
        },
        {
          entityType: 'session',
          entityId: 'sess456',
          worldId: 1,
          attributes: { lastActive: '2023-01-01' },
          isCreate: true
        }
      ];

      // Configure pipeline mocks before calling the method
      // Now creates 3 pipelines: existence check, main pipeline, version update pipeline
      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const versionPipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return versionPipeline;
        }
      });

      // Mock existence check - entities don't exist
      existsPipeline.exec.mockResolvedValueOnce([[null, null], [null, null]]);

      // Mock main pipeline - sadd (dirty), JSON.SET, set version for each entity
      mainPipeline.exec.mockResolvedValueOnce([
        [null, 1], // sadd for player
        [null, 'OK'], // JSON.SET player
        [null, '1'], // set version player
        [null, 1], // sadd for session
        [null, 'OK'], // JSON.SET session
        [null, '1'] // set version session
      ]);

      // Mock version update pipeline - JSON.SET version, JSON.COPY, expire for each
      versionPipeline.exec.mockResolvedValueOnce([
        [null, 'OK'], // JSON.SET version player
        [null, 'OK'], // JSON.COPY player
        [null, 1], // expire player
        [null, 'OK'], // JSON.SET version session
        [null, 'OK'], // JSON.COPY session
        [null, 1] // expire session
      ]);

      // Mock stream manager
      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([
        { success: true, version: 1 },
        { success: true, version: 1 }
      ]);

      // Verify sadd calls for dirty set
      expect(mainPipeline.sadd).toHaveBeenCalledWith(
        'ephemeral:dirty_entities',
        'player:1:user123'
      );

      // Verify JSON.SET calls for new entities
      expect(mainPipeline.call).toHaveBeenCalledWith(
        'JSON.SET',
        'ephemeral:player:1:user123',
        '$',
        expect.stringContaining('"type":"ephemeral"')
      );
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
      const versionPipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return versionPipeline;
        }
      });

      // Mock existence check - entity exists
      existsPipeline.exec.mockResolvedValueOnce([[null, 'object']]);

      // Mock main pipeline - now includes sadd for dirty set
      mainPipeline.exec.mockResolvedValueOnce([
        [null, 1],    // sadd for dirty set
        [null, 'OK'], // JSON.SET level
        [null, 'OK'], // JSON.SET experience
        [null, 'OK'], // JSON.SET worldId
        [null, 'OK'], // JSON.SET lastWrite
        [null, 2]     // incr version
      ]);

      // Mock version update pipeline
      versionPipeline.exec.mockResolvedValueOnce([
        [null, 'OK'], // JSON.SET version
        [null, 'OK'], // JSON.COPY
        [null, 1]     // expire
      ]);

      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toEqual([{ success: true, version: 2 }]);

      // Verify sadd for dirty set
      expect(mainPipeline.sadd).toHaveBeenCalledWith(
        'ephemeral:dirty_entities',
        'player:1:user123'
      );

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
        attributes: { level: i + 1 },
        isCreate: true
      }));

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const versionPipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return versionPipeline;
        }
      });

      // Mock all entities as new
      const existsResults = Array.from({ length: 150 }, () => [null, null]);
      existsPipeline.exec.mockResolvedValueOnce(existsResults);

      // For each new entity: sadd + JSON.SET + set version = 3 commands per entity
      const mainPipelineResults = Array.from({ length: 150 }, () => [
        [null, 1],     // sadd
        [null, 'OK'],  // JSON.SET
        [null, '1']    // set version
      ]).flat();
      mainPipeline.exec.mockResolvedValueOnce(mainPipelineResults);

      // Version update pipeline: JSON.SET + JSON.COPY + expire per entity
      const versionPipelineResults = Array.from({ length: 150 }, () => [
        [null, 'OK'],  // JSON.SET version
        [null, 'OK'],  // JSON.COPY
        [null, 1]      // expire
      ]).flat();
      versionPipeline.exec.mockResolvedValue(versionPipelineResults);

      mockStreamManager.batchAddToStreams.mockResolvedValue([]);

      const result = await ephemeralManager.batchSavePartial(updates);

      expect(result).toHaveLength(150);
      expect(result.every(r => r.success)).toBe(true);

      // Should be called: exists check, main pipeline
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
          attributes: { level: 10, gold: 500 },
          isCreate: true
        }
      ];

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const versionPipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return versionPipeline;
        }
      });

      existsPipeline.exec.mockResolvedValueOnce([[null, null]]);
      mainPipeline.exec.mockResolvedValueOnce([[null, 1], [null, 'OK'], [null, '1']]);
      versionPipeline.exec.mockResolvedValueOnce([[null, 'OK'], [null, 'OK'], [null, 1]]);

      mockStreamManager.batchAddToStreams.mockResolvedValueOnce([]);

      await ephemeralManager.batchSavePartial(updates);

      // Wait for the setImmediate callback to execute
      await new Promise(resolve => setImmediate(resolve));

      // Verify stream manager is called with correct data and streamId format
      expect(mockStreamManager.batchAddToStreams).toHaveBeenCalledWith([
        {
          streamId: 'entity:player:1:user123',
          data: { level: 10, gold: 500 }
        }
      ]);
    });

    test('should handle concurrent updates during flush (race condition)', async () => {
      // Simulate checking version in ephemeral storage - entity has version 5
      const versionCheckPipeline = createMockPipeline();
      versionCheckPipeline.exec.mockResolvedValueOnce([[null, '5']]);

      ephemeralManager.redis.pipeline = jest.fn(() => versionCheckPipeline);

      // Try to flush with persisted version 2 (should be skipped because current is 5)
      await ephemeralManager.flushPersistedEntities([
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          dirtyKey: 'player:1:user123',
          persistedVersion: 2
        }
      ]);

      // Verify version check pipeline was called
      expect(versionCheckPipeline.exec).toHaveBeenCalled();
      expect(versionCheckPipeline.get).toHaveBeenCalledWith('ephemeral:player:1:user123:version');

      // Entity should NOT be deleted because current version (5) > persisted version (2)
      // Verify srem was NOT called (entity not flushed)
      expect(ephemeralManager.redis.srem).not.toHaveBeenCalled();
    });

    test('should flush entity when persisted version matches current version', async () => {
      // Simulate checking version - entity has version 3
      const versionCheckPipeline = createMockPipeline();
      versionCheckPipeline.exec.mockResolvedValueOnce([[null, '3']]);

      // Simulate deletion pipeline with Lua script returning 1 (deleted)
      const deletionPipeline = createMockPipeline();
      deletionPipeline.exec.mockResolvedValueOnce([[null, 1]]);

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return versionCheckPipeline;
        } else {
          return deletionPipeline;
        }
      });

      ephemeralManager.redis.srem = jest.fn().mockResolvedValueOnce(1);

      // Try to flush with persisted version 3 (should succeed)
      await ephemeralManager.flushPersistedEntities([
        {
          entityType: 'player',
          entityId: 'user456',
          worldId: 1,
          dirtyKey: 'player:1:user456',
          persistedVersion: 3
        }
      ]);

      // Verify pipelines were called
      expect(versionCheckPipeline.exec).toHaveBeenCalled();
      expect(versionCheckPipeline.get).toHaveBeenCalledWith('ephemeral:player:1:user456:version');

      // Verify deletion pipeline was called and contained eval call
      expect(deletionPipeline.eval).toHaveBeenCalled();
      expect(deletionPipeline.exec).toHaveBeenCalled();

      // Verify dirty key was removed
      expect(ephemeralManager.redis.srem).toHaveBeenCalledWith(
        'ephemeral:dirty_entities',
        'player:1:user456'
      );
    });

    test('should handle stream update failures gracefully', async () => {
      const updates = [
        {
          entityType: 'player',
          entityId: 'user123',
          worldId: 1,
          attributes: { level: 10 },
          isCreate: true
        }
      ];

      const existsPipeline = createMockPipeline();
      const mainPipeline = createMockPipeline();
      const versionPipeline = createMockPipeline();

      let pipelineCallCount = 0;
      ephemeralManager.redis.pipeline = jest.fn(() => {
        if (pipelineCallCount === 0) {
          pipelineCallCount++;
          return existsPipeline;
        } else if (pipelineCallCount === 1) {
          pipelineCallCount++;
          return mainPipeline;
        } else {
          return versionPipeline;
        }
      });

      existsPipeline.exec.mockResolvedValueOnce([[null, null]]);
      mainPipeline.exec.mockResolvedValueOnce([[null, 1], [null, 'OK'], [null, '1']]);
      versionPipeline.exec.mockResolvedValueOnce([[null, 'OK'], [null, 'OK'], [null, 1]]);

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

      // Combined pipeline: 2 JSON.GET for entities + 2 GET for world instances
      pipeline.exec.mockResolvedValueOnce([
        [null, JSON.stringify(mockEntity1)],  // JSON.GET player
        [null, JSON.stringify(mockEntity2)],  // JSON.GET session
        [null, null],                          // GET world instance player
        [null, null]                           // GET world instance session
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([
        { ...mockEntity1, worldInstanceId: '' },
        { ...mockEntity2, worldInstanceId: '' }
      ]);

      expect(pipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:player:1:user123');
      expect(pipeline.call).toHaveBeenCalledWith('JSON.GET', 'ephemeral:session:1:sess456');
      expect(pipeline.get).toHaveBeenCalledWith('stream_world_instance:entity:player:1:user123');
      expect(pipeline.get).toHaveBeenCalledWith('stream_world_instance:entity:session:1:sess456');
    });

    test('should handle non-existent entities', async () => {
      const requests = [
        { entityType: 'player', entityId: 'nonexistent', worldId: 1 }
      ];

      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);

      pipeline.exec.mockResolvedValueOnce([
        [null, null], // Entity doesn't exist
        [null, null]  // World instance
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
        [null, JSON.stringify(mockEntity)],     // Second load succeeds
        [null, null],                            // World instance for first
        [null, 'world-instance-1']               // World instance for second
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null, { ...mockEntity, worldInstanceId: 'world-instance-1' }]);
    });

    test('should handle Redis pipeline failure', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      const error = new Error('Pipeline execution failed');
      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);
      pipeline.exec.mockRejectedValueOnce(error);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([null]);
    });

    test('should handle invalid JSON in Redis', async () => {
      const requests = [
        { entityType: 'player', entityId: 'user123', worldId: 1 }
      ];

      const pipeline = createMockPipeline();
      ephemeralManager.redis.pipeline = jest.fn(() => pipeline);

      pipeline.exec.mockResolvedValueOnce([
        [null, 'invalid json string'],
        [null, null]
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
        [null, null],                         // doesn't exist
        [null, JSON.stringify(mockEntity3)], // exists
        [null, 'world-1'],                   // world instance 1
        [null, null],                        // world instance 2 (none)
        [null, 'world-2']                    // world instance 3
      ]);

      const result = await ephemeralManager.batchLoad(requests);

      expect(result).toEqual([
        { ...mockEntity1, worldInstanceId: 'world-1' },
        null,
        { ...mockEntity3, worldInstanceId: 'world-2' }
      ]);
    });
  });
});