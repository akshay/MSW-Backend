// tests/StreamManager.test.js

// Mock pipeline object
const mockPipeline = {
  xadd: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  xrange: jest.fn().mockReturnThis(),
  exec: jest.fn()
};

// Mock Redis
const mockRedis = {
  pipeline: jest.fn(() => mockPipeline),
  get: jest.fn(),
  setex: jest.fn(),
  xadd: jest.fn(),
  xrange: jest.fn(),
  expire: jest.fn()
};

jest.mock('../cloud/config.js', () => ({
  streamRedis: {
    pipeline: jest.fn(() => ({
      xadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      xrange: jest.fn().mockReturnThis(),
      exec: jest.fn()
    })),
    get: jest.fn(),
    setex: jest.fn(),
    xadd: jest.fn(),
    xrange: jest.fn(),
    expire: jest.fn()
  }
}));

import { StreamManager } from '../cloud/util/StreamManager.js';

describe('StreamManager', () => {
  let streamManager;

  beforeEach(() => {
    streamManager = new StreamManager();
    jest.clearAllMocks();
    // Set up the mock to return the pipeline
    streamManager.redis.pipeline.mockReturnValue(mockPipeline);
  });

  describe('constructor', () => {
    test('should initialize with correct properties', () => {
      expect(streamManager.redis).toBeDefined();
      expect(streamManager.worldInstanceTTL).toBe(5);
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
      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    });

    test('should handle Redis errors gracefully', async () => {
      const streamUpdates = [
        { streamId: 'stream1', data: { field1: 'value1' } }
      ];

      const error = new Error('Redis connection failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await streamManager.batchAddToStreams(streamUpdates);

      expect(result).toEqual([
        { success: false, error: 'Redis connection failed' }
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
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:stream1', 60);
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:stream2', 60);
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
          streamId: 'stream1',
          messages: [
            { type: 'update', data: 'test1' },
            { type: 'update', data: 'test2' }
          ]
        },
        {
          streamId: 'stream2',
          messages: [
            { type: 'delete', data: 'test3' }
          ]
        }
      ];

      mockPipeline.exec.mockResolvedValueOnce([]);

      const result = await streamManager.batchAddMessages(streamCommands);

      expect(result).toEqual([
        { success: true },
        { success: true }
      ]);

      expect(streamManager.redis.pipeline).toHaveBeenCalledTimes(1);
      expect(mockPipeline.xadd).toHaveBeenCalledTimes(3); // 2 + 1 messages
      expect(mockPipeline.expire).toHaveBeenCalledTimes(2);
      expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
    });

    test('should handle Redis errors gracefully', async () => {
      const streamCommands = [
        { streamId: 'stream1', messages: [{ data: 'test' }] }
      ];

      const error = new Error('Pipeline failed');
      mockPipeline.exec.mockRejectedValueOnce(error);

      const result = await streamManager.batchAddMessages(streamCommands);

      expect(result).toEqual([
        { success: false, error: 'Pipeline failed' }
      ]);
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
        { streamId: 'stream1', worldInstanceId: 'world123', timestamp: '0-0' }
      ];

      // Mock no current association
      streamManager.redis.get.mockResolvedValueOnce(null);
      streamManager.redis.setex.mockResolvedValueOnce('OK');

      // Mock stream messages
      const mockMessages = [
        ['1234567890-0', ['data', '{"test":"value"}', 'timestamp', '1234567890']]
      ];
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

      expect(streamManager.redis.get).toHaveBeenCalledWith('stream_world_instance:stream1');
      expect(streamManager.redis.setex).toHaveBeenCalledWith('stream_world_instance:stream1', 5, 'world123');
      expect(mockPipeline.xrange).toHaveBeenCalledWith('stream:stream1', '0-0', '+', 'COUNT', 1000);
    });

    test('should handle existing same world instance', async () => {
      const pullCommands = [
        { streamId: 'stream1', worldInstanceId: 'world123' }
      ];

      // Mock existing same association
      streamManager.redis.get.mockResolvedValueOnce('world123');
      streamManager.redis.setex.mockResolvedValueOnce('OK');

      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result[0].worldInstanceId).toBe('world123');
      expect(streamManager.redis.setex).toHaveBeenCalledWith('stream_world_instance:stream1', 5, 'world123');
    });

    test('should handle different world instance', async () => {
      const pullCommands = [
        { streamId: 'stream1', worldInstanceId: 'world456' }
      ];

      // Mock existing different association
      streamManager.redis.get.mockResolvedValueOnce('world123');

      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      const result = await streamManager.batchPullMessages(pullCommands);

      expect(result[0].worldInstanceId).toBe('world123'); // Should return existing association
      expect(streamManager.redis.setex).not.toHaveBeenCalled(); // Should not update
    });

    test('should handle Redis errors in stream pull', async () => {
      const pullCommands = [
        { streamId: 'stream1', worldInstanceId: 'world123' }
      ];

      streamManager.redis.get.mockResolvedValueOnce(null);
      streamManager.redis.setex.mockResolvedValueOnce('OK');

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
        { streamId: 'stream1', worldInstanceId: 'world123' },
        { streamId: 'stream2', worldInstanceId: 'world456' }
      ];

      // Mock world instance associations
      streamManager.redis.get
        .mockResolvedValueOnce(null) // stream1 - no association
        .mockResolvedValueOnce('world999'); // stream2 - different association

      streamManager.redis.setex.mockResolvedValue('OK');

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
        { streamId: 'stream1', worldInstanceId: 'world123' } // No timestamp
      ];

      streamManager.redis.get.mockResolvedValueOnce(null);
      streamManager.redis.setex.mockResolvedValueOnce('OK');
      mockPipeline.exec.mockResolvedValueOnce([[null, []]]);

      await streamManager.batchPullMessages(pullCommands);

      expect(mockPipeline.xrange).toHaveBeenCalledWith('stream:stream1', '-', '+', 'COUNT', 1000);
    });
  });
});