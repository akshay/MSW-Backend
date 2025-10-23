// tests/StreamManager.test.js

// Mock pipeline object
const mockPipeline = {
  xadd: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  xrange: jest.fn().mockReturnThis(),
  setex: jest.fn().mockReturnThis(),
  exec: jest.fn(),
  length: 0
};

// Mock Redis
const mockRedis = {
  pipeline: jest.fn(() => mockPipeline),
  get: jest.fn(),
  mget: jest.fn(),
  setex: jest.fn(),
  xadd: jest.fn(),
  xrange: jest.fn(),
  expire: jest.fn()
};

jest.mock('../config.js', () => ({
  streamRedis: {
    pipeline: jest.fn(() => ({
      xadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      xrange: jest.fn().mockReturnThis(),
      exec: jest.fn()
    })),
    get: jest.fn(),
    mget: jest.fn(),
    setex: jest.fn(),
    xadd: jest.fn(),
    xrange: jest.fn(),
    expire: jest.fn()
  },
  cacheTTL: 300,
  config: {
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

import { StreamManager } from '../util/StreamManager.js';

describe('StreamManager', () => {
  let streamManager;

  beforeEach(() => {
    streamManager = new StreamManager();
    jest.clearAllMocks();
    // Reset pipeline mocks after clearAllMocks
    mockPipeline.exec = jest.fn();
    mockPipeline.setex = jest.fn().mockReturnThis();
    mockPipeline.xrange = jest.fn().mockReturnThis();
    mockPipeline.xadd = jest.fn().mockReturnThis();
    mockPipeline.expire = jest.fn().mockReturnThis();
    mockPipeline.length = 0;

    // Set up the mock to return the pipeline
    streamManager.redis.pipeline.mockReturnValue(mockPipeline);
    // Set up mget mock to return empty array by default
    streamManager.redis.mget = jest.fn().mockResolvedValue([]);
  });

  describe('constructor', () => {
    test('should initialize with correct properties', () => {
      expect(streamManager.redis).toBeDefined();
      expect(streamManager.worldInstanceTTL).toBe(3); // 300 / 100 = 3
    });
  });

  describe('getWorldInstanceKey', () => {
    test('should generate correct world instance key', () => {
      const streamId = 'test-stream-123';
      const key = streamManager.getWorldInstanceKey(streamId);
      expect(key).toBe('stream_world_instance:test-stream-123');
    });
  });

  describe('batchAddToStreams', () => {
    test('should handle empty array', async () => {
      const result = await streamManager.batchAddToStreams([]);
      expect(result).toEqual([]);
      expect(streamManager.redis.pipeline).not.toHaveBeenCalled();
    });

    test('should successfully batch add to multiple streams', async () => {
      const streamUpdates = [
        { streamId: 'stream1', data: { field1: 'value1' } },
        { streamId: 'stream1', data: { field2: 'value2' } },
        { streamId: 'stream2', data: { field3: 'value3' } }
      ];

      mockPipeline.exec.mockResolvedValueOnce([]);

      const result = await streamManager.batchAddToStreams(streamUpdates);

      expect(result).toEqual([
        { success: true },
        { success: true },
        { success: true }
      ]);

      expect(streamManager.redis.pipeline).toHaveBeenCalledTimes(1);
      expect(mockPipeline.xadd).toHaveBeenCalledTimes(3);
      expect(mockPipeline.expire).toHaveBeenCalledTimes(2); // 2 unique streams
      // Note: exec is called via setImmediate (fire-and-forget), so we don't test it
    });

    test('should handle Redis errors gracefully', async () => {
      const streamUpdates = [
        { streamId: 'stream1', data: { field1: 'value1' } }
      ];

      const error = new Error('Redis connection failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await streamManager.batchAddToStreams(streamUpdates);

      // Fire-and-forget always returns success immediately
      expect(result).toEqual([
        { success: true }
      ]);
    });

    test('should group messages by stream ID correctly', async () => {
      const streamUpdates = [
        { streamId: 'stream1', data: { msg: 1 } },
        { streamId: 'stream2', data: { msg: 2 } },
        { streamId: 'stream1', data: { msg: 3 } }
      ];

      mockPipeline.exec.mockResolvedValueOnce([]);

      await streamManager.batchAddToStreams(streamUpdates);

      // Verify that stream1 gets 2 messages and stream2 gets 1
      expect(mockPipeline.xadd).toHaveBeenCalledTimes(3);
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:stream1', 300); // cacheTTL is 300
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:stream2', 300); // cacheTTL is 300
    });
  });

  describe('batchAddMessages', () => {
    test('should handle empty array', async () => {
      const result = await streamManager.batchAddMessages([]);
      expect(result).toEqual([]);
      expect(streamManager.redis.pipeline).not.toHaveBeenCalled();
    });

    test('should successfully batch add messages', async () => {
      const streamCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          message: { type: 'update', data: 'test1' }
        },
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          message: { type: 'update', data: 'test2' }
        },
        {
          entityType: 'guild',
          entityId: 'guild1',
          worldId: 1,
          message: { type: 'delete', data: 'test3' }
        }
      ];

      mockPipeline.exec.mockResolvedValueOnce([]);

      const result = await streamManager.batchAddMessages(streamCommands);

      expect(result).toEqual([
        { success: true },
        { success: true },
        { success: true }
      ]);

      expect(streamManager.redis.pipeline).toHaveBeenCalledTimes(1);
      expect(mockPipeline.xadd).toHaveBeenCalledTimes(3);
      expect(mockPipeline.expire).toHaveBeenCalledTimes(2); // 2 unique streams
      // Note: exec is called via setImmediate (fire-and-forget), so we don't test it
    });

    test('should handle Redis errors gracefully', async () => {
      const streamCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          message: { data: 'test' }
        }
      ];

      const error = new Error('Pipeline failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await streamManager.batchAddMessages(streamCommands);

      // Fire-and-forget always returns success immediately
      expect(result).toEqual([
        { success: true }
      ]);
    });

    test('should construct streamId from entityType, worldId, and entityId', async () => {
      const streamCommands = [
        {
          entityType: 'player',
          entityId: 'player123',
          worldId: 42,
          message: { action: 'levelup', level: 5 }
        }
      ];

      mockPipeline.exec.mockResolvedValueOnce([]);

      await streamManager.batchAddMessages(streamCommands);

      // Verify the streamId is constructed correctly as entity:entityType:worldId:entityId
      expect(mockPipeline.xadd).toHaveBeenCalled();
      const xaddCall = mockPipeline.xadd.mock.calls[0];
      expect(xaddCall[0]).toBe('stream:entity:player:42:player123');
    });
  });

  describe('batchPullMessages', () => {
    test('should handle empty array', async () => {
      const result = await streamManager.batchPullMessages([]);
      expect(result).toEqual([]);
      expect(streamManager.redis.pipeline).not.toHaveBeenCalled();
    });

    test('should successfully pull messages with new world instance', async () => {
      const pullCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          worldInstanceId: 'world123',
          timestamp: '0-0'
        }
      ];

      // Mock no current association (mget returns [null])
      streamManager.redis.mget.mockResolvedValueOnce([null]);

      // Mock stream messages
      const mockMessages = [
        ['1234567890-0', ['data', '{"test":"value"}', 'timestamp', '1234567890']]
      ];

      // Mock the xrange pipeline exec to return messages
      mockPipeline.exec.mockResolvedValueOnce([[null, mockMessages]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result).toEqual([
        {
          success: true,
          worldInstanceId: 'world123',
          data: [
            {
              id: '1234567890-0',
              data: { test: 'value' },
              timestamp: 1234567890
            }
          ]
        }
      ]);

      expect(streamManager.redis.mget).toHaveBeenCalledWith(['stream_world_instance:entity:player:1:player1']);
      expect(mockPipeline.xrange).toHaveBeenCalledWith('stream:entity:player:1:player1', '0-0', '+', 'COUNT', 1000);
    });

    test('should handle existing same world instance', async () => {
      const pullCommands = [
        {
          entityType: 'guild',
          entityId: 'guild1',
          worldId: 2,
          worldInstanceId: 'world123'
        }
      ];

      // Mock existing same association (mget returns ['world123'])
      streamManager.redis.mget.mockResolvedValueOnce(['world123']);

      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result[0].worldInstanceId).toBe('world123');
      expect(streamManager.redis.mget).toHaveBeenCalledWith(['stream_world_instance:entity:guild:2:guild1']);
    });

    test('should handle different world instance', async () => {
      const pullCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          worldInstanceId: 'world456'
        }
      ];

      // Mock existing different association (mget returns ['world123'])
      streamManager.redis.mget.mockResolvedValueOnce(['world123']);

      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result[0].worldInstanceId).toBe('world123'); // Should return existing association
      expect(streamManager.redis.setex).not.toHaveBeenCalled(); // Should not update
    });

    test('should handle Redis errors in stream pull', async () => {
      const pullCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          worldInstanceId: 'world123'
        }
      ];

      // Mock no current association (mget returns [null])
      streamManager.redis.mget.mockResolvedValueOnce([null]);

      const error = new Error('Stream read failed');
      mockPipeline.exec.mockResolvedValueOnce([[error, null]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result).toEqual([
        {
          success: false,
          error: 'Stream read failed',
          worldInstanceId: 'world123',
          data: []
        }
      ]);
    });

    test('should handle multiple commands with mixed results', async () => {
      const pullCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          worldInstanceId: 'world123'
        },
        {
          entityType: 'guild',
          entityId: 'guild1',
          worldId: 1,
          worldInstanceId: 'world456'
        }
      ];

      // Mock world instance associations (mget returns [null, 'world999'])
      streamManager.redis.mget.mockResolvedValueOnce([null, 'world999']);

      // Mock stream results
      const mockMessages = [
        ['1-0', ['data', '{"msg":1}', 'timestamp', '1000']]
      ];
      mockPipeline.exec.mockResolvedValueOnce([
        [null, mockMessages], // stream1 success
        [null, []] // stream2 empty
      ]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result).toHaveLength(2);
      expect(result[0].worldInstanceId).toBe('world123');
      expect(result[0].data).toHaveLength(1);
      expect(result[1].worldInstanceId).toBe('world999'); // Returns existing association
      expect(result[1].data).toHaveLength(0);
    });

    test('should use default timestamp when not provided', async () => {
      const pullCommands = [
        {
          entityType: 'player',
          entityId: 'player1',
          worldId: 1,
          worldInstanceId: 'world123'
          // No timestamp
        }
      ];

      // Mock no current association (mget returns [null])
      streamManager.redis.mget.mockResolvedValueOnce([null]);
      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      await streamManager.batchPullMessages(pullCommands);

      expect(mockPipeline.xrange).toHaveBeenCalledWith('stream:entity:player:1:player1', '-', '+', 'COUNT', 1000);
    });

    test('should construct streamId correctly from entity info', async () => {
      const pullCommands = [
        {
          entityType: 'quest',
          entityId: 'quest999',
          worldId: 5,
          worldInstanceId: 'world-abc'
        }
      ];

      // Mock no current association (mget returns [null])
      streamManager.redis.mget.mockResolvedValueOnce([null]);
      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      await streamManager.batchPullMessages(pullCommands);

      // Verify streamId format is entity:entityType:worldId:entityId
      expect(streamManager.redis.mget).toHaveBeenCalledWith(['stream_world_instance:entity:quest:5:quest999']);
      expect(mockPipeline.xrange).toHaveBeenCalledWith('stream:entity:quest:5:quest999', '-', '+', 'COUNT', 1000);
    });
  });
});