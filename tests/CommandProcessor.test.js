// tests/CommandProcessor.test.js

// Mock dependencies
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  defaultTTL: 500  // 500 / 100 = 5 seconds for sequence number TTL
};

const mockStreamManager = {
  batchAddToStreams: jest.fn(),
  batchAddMessages: jest.fn(),
  batchPullMessages: jest.fn()
};

const mockEphemeralManager = {
  batchLoad: jest.fn(),
  batchSavePartial: jest.fn()
};

const mockPersistentManager = {
  batchLoad: jest.fn()
};

// Mock the classes that CommandProcessor imports first
jest.mock('../util/StreamManager.js', () => ({
  StreamManager: jest.fn(() => ({
    batchAddToStreams: jest.fn(),
    batchAddMessages: jest.fn(),
    batchPullMessages: jest.fn()
  }))
}));

jest.mock('../util/EphemeralEntityManager.js', () => ({
  EphemeralEntityManager: jest.fn(() => ({
    batchLoad: jest.fn(),
    batchSavePartial: jest.fn()
  }))
}));

jest.mock('../util/PersistentEntityManager.js', () => ({
  PersistentEntityManager: jest.fn(() => ({
    batchLoad: jest.fn()
  }))
}));

jest.mock('../config.js', () => ({
  config: {
    entityTypes: {
      ephemeral: ['session', 'temporary_data']
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

// Mock HybridCacheManager
jest.mock('../util/HybridCacheManager.js', () => ({
  HybridCacheManager: jest.fn(() => ({
    defaultTTL: 500,  // 500 / 100 = 5 seconds for sequence number TTL
    get: jest.fn(),
    set: jest.fn()
  }))
}));

const mockConfig = {
  entityTypes: {
    ephemeral: ['session', 'temporary_data']
  }
};

// Mock @stablelib/nacl functions
jest.mock('@stablelib/nacl', () => ({
  precomputeSharedKey: jest.fn(),
  openSecretBox: jest.fn(),
  box: jest.fn()
}));

// Mock @stablelib/base64
jest.mock('@stablelib/base64', () => ({
  decode: jest.fn(),
  encode: jest.fn()
}));

import { CommandProcessor } from '../util/CommandProcessor.js';
import * as nacl from '@stablelib/nacl';
import * as base64 from '@stablelib/base64';

// Get references to the mocked functions
const mockBoxBefore = nacl.precomputeSharedKey;
const mockBoxOpenAfternm = nacl.openSecretBox;
const mockDecodeBase64 = base64.decode;
const mockEncodeBase64 = base64.encode;

describe('CommandProcessor', () => {
  let commandProcessor;
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env;
  });

  beforeEach(() => {
    // Setup environment variables
    process.env.SENDER_PUBLIC_KEY = 'dGVzdFB1YmxpY0tleQ==';
    process.env.RECIPIENT_PRIVATE_KEY = 'dGVzdFByaXZhdGVLZXk=';

    // Mock stablelib functions
    mockDecodeBase64.mockReturnValue(new Uint8Array(32));
    mockBoxBefore.mockReturnValue(new Uint8Array(32));

    commandProcessor = new CommandProcessor();

    // Wire up the mock cache to the instance
    commandProcessor.cache = mockCache;
    commandProcessor.ephemeralManager = mockEphemeralManager;
    commandProcessor.persistentManager = mockPersistentManager;
    commandProcessor.streamManager = mockStreamManager;

    // Clear mocks AFTER instance creation, but verify nacl was called during construction
    const decodeBase64Calls = mockDecodeBase64.mock.calls.length;
    const boxBeforeCalls = mockBoxBefore.mock.calls.length;

    jest.clearAllMocks();

    // Restore the call counts for constructor test verification
    if (decodeBase64Calls > 0) {
      mockDecodeBase64.mockReturnValue(new Uint8Array(32));
      // Mark that decodeBase64 was called during construction
      mockDecodeBase64.wasCalledDuringConstruction = true;
    }
    if (boxBeforeCalls > 0) {
      mockBoxBefore.mockReturnValue(new Uint8Array(32));
      // Mark that box_before was called during construction
      mockBoxBefore.wasCalledDuringConstruction = true;
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    test('should initialize with correct dependencies', () => {
      expect(commandProcessor.cache).toBeDefined();
      expect(commandProcessor.streamManager).toBeDefined();
      expect(commandProcessor.ephemeralManager).toBeDefined();
      expect(commandProcessor.persistentManager).toBeDefined();
    });

    test('should initialize decryption correctly', () => {
      expect(commandProcessor.expectedAuth).toBe('dGVzdFB1YmxpY0tleQ==');
      expect(commandProcessor.sharedSecret).toBeInstanceOf(Uint8Array);
      expect(mockDecodeBase64.wasCalledDuringConstruction).toBe(true);
      expect(mockBoxBefore.wasCalledDuringConstruction).toBe(true);
    });

    test('should throw error when environment variables missing', () => {
      delete process.env.SENDER_PUBLIC_KEY;
      
      expect(() => new CommandProcessor()).toThrow(
        'SENDER_PUBLIC_KEY and RECIPIENT_PRIVATE_KEY environment variables are required'
      );
    });
  });

  describe('readLittleEndianUint64', () => {
    test('should read 64-bit little-endian integer correctly', () => {
      const bytes = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]);
      const result = commandProcessor.readLittleEndianUint64(bytes, 0);
      expect(result).toBe(1);
    });

    test('should handle larger numbers', () => {
      const bytes = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
      const result = commandProcessor.readLittleEndianUint64(bytes, 0);
      expect(result).toBe(4294967295); // 2^32 - 1
    });

    test('should handle offset correctly', () => {
      const bytes = new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
      const result = commandProcessor.readLittleEndianUint64(bytes, 2);
      expect(result).toBe(1);
    });
  });

  describe('validateSequenceNumber', () => {
    test('should accept first sequence number', async () => {
      mockCache.get.mockResolvedValueOnce(null);
      mockCache.set.mockResolvedValueOnce();

      await expect(
        commandProcessor.validateSequenceNumber('world123', 1000)
      ).resolves.not.toThrow();

      expect(mockCache.get).toHaveBeenCalledWith('sequence:world123');
      expect(mockCache.set).toHaveBeenCalledWith('sequence:world123', 1000, 5);
    });

    test('should accept increasing sequence number', async () => {
      mockCache.get.mockResolvedValueOnce(1000);
      mockCache.set.mockResolvedValueOnce();

      await expect(
        commandProcessor.validateSequenceNumber('world123', 1001)
      ).resolves.not.toThrow();

      expect(mockCache.set).toHaveBeenCalledWith('sequence:world123', 1001, 5);
    });

    test('should reject non-increasing sequence number', async () => {
      mockCache.get.mockResolvedValueOnce(1000);

      await expect(
        commandProcessor.validateSequenceNumber('world123', 1000)
      ).rejects.toThrow('Invalid sequence number: 1000 must be greater than 1000');
    });

    test('should reject decreasing sequence number', async () => {
      mockCache.get.mockResolvedValueOnce(1000);

      await expect(
        commandProcessor.validateSequenceNumber('world123', 999)
      ).rejects.toThrow('Invalid sequence number: 999 must be greater than 1000');
    });

    test('should handle cache errors gracefully', async () => {
      mockCache.get.mockRejectedValueOnce(new Error('Cache error'));

      await expect(
        commandProcessor.validateSequenceNumber('world123', 1000)
      ).rejects.toThrow('Sequence number validation failed: Cache error');
    });
  });

  describe('validateAndDecryptRequest', () => {
    const validPayload = {
      encrypted: 'validencryptedstring24!!', // Exactly 24 characters
      nonce: 'dmFsaWROb25jZUJ5dGVzISEhIQ==', // 24 bytes when decoded
      worldInstanceId: 'world123',
      auth: 'dGVzdFB1YmxpY0tleQ=='
    };

    beforeEach(() => {
      // Mock nonce decoding to return 24 bytes
      mockDecodeBase64.mockImplementation((input) => {
        if (input === validPayload.nonce) {
          return new Uint8Array(24); // Return 24 bytes for nonce
        }
        return new Uint8Array(32); // Default for keys
      });

      // Mock successful decryption
      // The actual ASCII encoding/decoding will happen in the real code
      mockBoxOpenAfternm.mockReturnValue(new Uint8Array(Array.from('world123', c => c.charCodeAt(0))));

      // Mock sequence validation
      mockCache.get.mockResolvedValue(null);
      mockCache.set.mockResolvedValue();
    });

    test('should validate and decrypt valid request', async () => {
      await expect(
        commandProcessor.validateAndDecryptRequest(validPayload)
      ).resolves.not.toThrow();
    });

    test('should reject invalid auth token', async () => {
      const invalidPayload = { ...validPayload, auth: 'invalid_auth' };

      await expect(
        commandProcessor.validateAndDecryptRequest(invalidPayload)
      ).rejects.toThrow('Authentication failed: invalid auth token');
    });

    test('should reject missing nonce', async () => {
      const invalidPayload = {
        ...validPayload,
        nonce: null,
        encrypted: 'validencryptedstring24!!' // Ensure encrypted passes length check (24 chars)
      };

      await expect(
        commandProcessor.validateAndDecryptRequest(invalidPayload)
      ).rejects.toThrow('Nonce is required');
    });

    test('should reject invalid nonce length', async () => {
      mockDecodeBase64.mockImplementation((input) => {
        if (input === 'shortNonce') {
          return new Uint8Array(16); // Wrong length
        }
        return new Uint8Array(32);
      });

      const invalidPayload = {
        ...validPayload,
        nonce: 'shortNonce',
        encrypted: 'validencryptedstring24!!' // Ensure encrypted passes length check (24 chars)
      };

      await expect(
        commandProcessor.validateAndDecryptRequest(invalidPayload)
      ).rejects.toThrow('Invalid nonce: decoded bytes must be exactly 24 bytes');
    });

    test('should reject decryption failure', async () => {
      mockBoxOpenAfternm.mockReturnValue(null);

      const testPayload = {
        ...validPayload,
        encrypted: 'validencryptedstring24!!' // Ensure encrypted passes length check (24 chars)
      };

      await expect(
        commandProcessor.validateAndDecryptRequest(testPayload)
      ).rejects.toThrow('Decryption failed');
    });

    test('should reject mismatched decrypted content', async () => {
      // Make decryption return bytes that decode to a different worldInstanceId
      const wrongWorldId = 'wrongworld';
      mockBoxOpenAfternm.mockReturnValue(new Uint8Array(Array.from(wrongWorldId, c => c.charCodeAt(0))));

      const testPayload = {
        ...validPayload,
        encrypted: 'validencryptedstring24!!' // Ensure encrypted passes length check (24 chars)
      };

      await expect(
        commandProcessor.validateAndDecryptRequest(testPayload)
      ).rejects.toThrow('Decryption verification failed: content does not match worldInstanceId');
    });
  });

  describe('groupCommandsByType', () => {
    test('should group commands by type correctly', () => {
      const commands = {
        load: [
          { entityType: 'player', worldId: 1 },
          { entityType: 'guild', worldId: 1 }
        ],
        save: [
          { entityType: 'player', worldId: 1 }
        ],
        send: [
          { entityType: 'chat', worldId: 1 }
        ],
        recv: [
          { entityType: 'events', worldId: 1 }
        ]
      };

      commandProcessor.groupCommandsByType(commands, 'world123');

      expect(commands.load).toHaveLength(2);
      expect(commands.save).toHaveLength(1);
      expect(commands.send).toHaveLength(1);
      expect(commands.recv).toHaveLength(1);
      expect(commands.recv[0].worldInstanceId).toBe('world123');
      expect(commands.load[0].type).toBe('load');
      expect(commands.save[0].type).toBe('save');
    });

    test('should validate required fields', () => {
      const invalidCommands1 = {
        load: [{ worldId: 1 }] // missing entityType
      };

      expect(() => {
        commandProcessor.groupCommandsByType(invalidCommands1, 'world123');
      }).toThrow('entityType is required');

      const invalidCommands2 = {
        save: [{ entityType: 'player' }] // missing worldId
      };

      expect(() => {
        commandProcessor.groupCommandsByType(invalidCommands2, 'world123');
      }).toThrow('worldId is required');
    });
  });

  describe('isEphemeralEntityType', () => {
    test('should identify ephemeral entity types', () => {
      expect(commandProcessor.isEphemeralEntityType('session')).toBe(true);
      expect(commandProcessor.isEphemeralEntityType('temporary_data')).toBe(true);
    });

    test('should identify persistent entity types', () => {
      expect(commandProcessor.isEphemeralEntityType('player')).toBe(false);
      expect(commandProcessor.isEphemeralEntityType('guild')).toBe(false);
    });
  });

  describe('processBatchedLoads', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedLoads([]);
      expect(result).toEqual([]);
    });

    test('should separate ephemeral and persistent loads', async () => {
      const commands = [
        { entityType: 'session', originalIndex: 0, type: 'load' },
        { entityType: 'player', originalIndex: 1, type: 'load' }
      ];

      // Mock the managers to return the correct number of results
      mockEphemeralManager.batchLoad.mockResolvedValueOnce([{ id: 'sess1' }]);
      mockPersistentManager.batchLoad.mockResolvedValueOnce([{ id: 'player1' }]);

      const result = await commandProcessor.processBatchedLoads(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'load',
        result: { id: 'sess1' }
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'load',
        result: { id: 'player1' }
      });
      expect(mockEphemeralManager.batchLoad).toHaveBeenCalledWith([{ entityType: 'session' }]);
      expect(mockPersistentManager.batchLoad).toHaveBeenCalledWith([{ entityType: 'player' }]);
    });
  });

  describe('processBatchedSaves', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedSaves([]);
      expect(result).toEqual([]);
    });

    test('should separate ephemeral and persistent saves', async () => {
      const commands = [
        { entityType: 'session', attributes: { active: true }, originalIndex: 0, type: 'save' },
        { entityType: 'player', attributes: { level: 10, rank_combat: 100 }, originalIndex: 1, type: 'save' }
      ];

      // Mock the managers to return the correct number of results
      // First call for ephemeral saves, second call for persistent saves
      mockEphemeralManager.batchSavePartial
        .mockResolvedValueOnce([{ success: true }])
        .mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedSaves(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'save',
        result: { success: true }
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'save',
        result: { success: true }
      });
      expect(mockEphemeralManager.batchSavePartial).toHaveBeenCalled();
    });

    test('should extract rank scores for persistent entities', async () => {
      const commands = [
        {
          entityType: 'player',
          attributes: {
            level: 10,
            rank_combat: 100,
            experience_score: 500,
            normal_attr: 'value'
          },
          originalIndex: 0,
          type: 'save'
        }
      ];

      mockEphemeralManager.batchSavePartial.mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedSaves(commands);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'save',
        result: { success: true }
      });
      expect(mockEphemeralManager.batchSavePartial).toHaveBeenCalledWith([{
        entityType: 'player',
        entityId: undefined,
        worldId: undefined,
        attributes: { level: 10, normal_attr: 'value' },
        rankScores: { rank_combat: 100, experience_score: 500 }
      }]);
    });
  });

  describe('processBatchedStreamAdds', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedStreamAdds([]);
      expect(result).toEqual([]);
    });

    test('should process stream add commands', async () => {
      const commands = [
        { streamId: 'chat1', messages: ['hello'], originalIndex: 0, type: 'send' }
      ];

      mockStreamManager.batchAddMessages.mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedStreamAdds(commands);

      expect(result).toEqual([{
        originalIndex: 0,
        type: 'send',
        result: { success: true }
      }]);
      expect(mockStreamManager.batchAddMessages).toHaveBeenCalledWith(commands);
    });
  });

  describe('processBatchedStreamPulls', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedStreamPulls([]);
      expect(result).toEqual([]);
    });

    test('should process stream pull commands', async () => {
      const commands = [
        { streamId: 'events1', timestamp: '0-0', originalIndex: 0, type: 'recv' }
      ];

      mockStreamManager.batchPullMessages.mockResolvedValueOnce([{
        success: true,
        data: [{ id: '1', data: 'event' }]
      }]);

      const result = await commandProcessor.processBatchedStreamPulls(commands);

      expect(result).toEqual([{
        originalIndex: 0,
        type: 'recv',
        result: { success: true, data: [{ id: '1', data: 'event' }] }
      }]);
      expect(mockStreamManager.batchPullMessages).toHaveBeenCalledWith(commands);
    });
  });

  describe('reconstructOrderedResults', () => {
    test('should reconstruct results in original command order', () => {
      const originalCommands = {
        load: [{}, {}, {}]
      };
      const batchResults = [
        { originalIndex: 2, type: 'load', result: 'third' },
        { originalIndex: 0, type: 'load', result: 'first' },
        { originalIndex: 1, type: 'load', result: 'second' }
      ];

      const result = commandProcessor.reconstructOrderedResults(originalCommands, batchResults);

      expect(result).toEqual({ load: ['first', 'second', 'third'] });
    });

    test('should handle missing results', () => {
      const originalCommands = {
        load: [{}, {}]
      };
      const batchResults = [
        { originalIndex: 0, type: 'load', result: 'first' }
        // Missing result for index 1
      ];

      const result = commandProcessor.reconstructOrderedResults(originalCommands, batchResults);

      expect(result).toEqual({ load: ['first', undefined] });
    });
  });

  describe('processBatchedSearchByName', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedSearchByName([]);
      expect(result).toEqual([]);
    });

    test('should process search commands', async () => {
      const commands = [
        { entityType: 'player', namePattern: 'John%', worldId: 1, limit: 10, originalIndex: 0, type: 'search' },
        { entityType: 'player', namePattern: 'Jane%', worldId: 1, limit: 5, originalIndex: 1, type: 'search' }
      ];

      mockPersistentManager.batchSearchByName = jest.fn()
        .mockResolvedValue([
          [{ id: 'player1', name: 'John Doe' }],
          [{ id: 'player2', name: 'Jane Smith' }]
        ]);

      const result = await commandProcessor.processBatchedSearchByName(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'search',
        result: [{ id: 'player1', name: 'John Doe' }]
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'search',
        result: [{ id: 'player2', name: 'Jane Smith' }]
      });
      expect(mockPersistentManager.batchSearchByName).toHaveBeenCalledWith([
        { entityType: 'player', namePattern: 'John%', worldId: 1, limit: 10 },
        { entityType: 'player', namePattern: 'Jane%', worldId: 1, limit: 5 }
      ]);
    });

    test('should use default limit of 100 when not specified', async () => {
      const commands = [
        { entityType: 'player', namePattern: 'Test%', worldId: 1, originalIndex: 0, type: 'search' }
      ];

      mockPersistentManager.batchSearchByName = jest.fn().mockResolvedValue([[]]);

      await commandProcessor.processBatchedSearchByName(commands);

      expect(mockPersistentManager.batchSearchByName).toHaveBeenCalledWith([
        { entityType: 'player', namePattern: 'Test%', worldId: 1, limit: 100 }
      ]);
    });
  });

  describe('processBatchedCalculateRank', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedCalculateRank([]);
      expect(result).toEqual([]);
    });

    test('should process rank calculation commands', async () => {
      const commands = [
        { entityType: 'player', worldId: 1, entityId: 'player1', rankKey: 'level', originalIndex: 0, type: 'rank' },
        { entityType: 'player', worldId: 1, entityId: 'player2', rankKey: 'experience', originalIndex: 1, type: 'rank' }
      ];

      mockPersistentManager.batchCalculateEntityRank = jest.fn()
        .mockResolvedValue([
          { rank: 1, score: 100 },
          { rank: 5, score: 50 }
        ]);

      const result = await commandProcessor.processBatchedCalculateRank(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'rank',
        result: { rank: 1, score: 100 }
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'rank',
        result: { rank: 5, score: 50 }
      });
      expect(mockPersistentManager.batchCalculateEntityRank).toHaveBeenCalledWith([
        { entityType: 'player', worldId: 1, entityId: 'player1', rankKey: 'level' },
        { entityType: 'player', worldId: 1, entityId: 'player2', rankKey: 'experience' }
      ]);
    });
  });

  describe('processBatchedGetRankings', () => {
    test('should handle empty array', async () => {
      const result = await commandProcessor.processBatchedGetRankings([]);
      expect(result).toEqual([]);
    });

    test('should process get rankings commands', async () => {
      const commands = [
        { entityType: 'player', worldId: 1, rankKey: 'level', sortOrder: 'DESC', limit: 10, originalIndex: 0, type: 'top' },
        { entityType: 'guild', worldId: 1, rankKey: 'power', sortOrder: 'ASC', limit: 20, originalIndex: 1, type: 'top' }
      ];

      mockPersistentManager.batchGetRankedEntities = jest.fn()
        .mockResolvedValue([
          [{ id: 'p1', rank: 1 }],
          [{ id: 'g1', rank: 1 }]
        ]);

      const result = await commandProcessor.processBatchedGetRankings(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'top',
        result: [{ id: 'p1', rank: 1 }]
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'top',
        result: [{ id: 'g1', rank: 1 }]
      });
      expect(mockPersistentManager.batchGetRankedEntities).toHaveBeenCalledWith([
        { entityType: 'player', worldId: 1, rankKey: 'level', sortOrder: 'DESC', limit: 10 },
        { entityType: 'guild', worldId: 1, rankKey: 'power', sortOrder: 'ASC', limit: 20 }
      ]);
    });

    test('should use default sortOrder and limit when not specified', async () => {
      const commands = [
        { entityType: 'player', worldId: 1, rankKey: 'level', originalIndex: 0, type: 'top' }
      ];

      mockPersistentManager.batchGetRankedEntities = jest.fn().mockResolvedValue([[]]);

      await commandProcessor.processBatchedGetRankings(commands);

      expect(mockPersistentManager.batchGetRankedEntities).toHaveBeenCalledWith([
        { entityType: 'player', worldId: 1, rankKey: 'level', sortOrder: 'DESC', limit: 100 }
      ]);
    });
  });

  describe('processCommands', () => {
    beforeEach(() => {
      // Mock validation and decryption
      jest.spyOn(commandProcessor, 'validateAndDecryptRequest').mockResolvedValue();

      // Mock batch processing methods
      jest.spyOn(commandProcessor, 'processBatchedLoads').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedSaves').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedStreamAdds').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedStreamPulls').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedSearchByName').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedCalculateRank').mockResolvedValue([]);
      jest.spyOn(commandProcessor, 'processBatchedGetRankings').mockResolvedValue([]);
    });

    test('should process valid command payload', async () => {
      const payload = {
        commands: {
          load: [{ entityType: 'player', worldId: 1 }]
        },
        worldInstanceId: 'world123'
      };

      jest.spyOn(commandProcessor, 'processBatchedLoads').mockResolvedValueOnce([
        { originalIndex: 0, type: 'load', result: { id: 'player1' } }
      ]);

      const result = await commandProcessor.processCommands(payload);

      expect(result).toEqual({ load: [{ id: 'player1' }] });
      expect(commandProcessor.validateAndDecryptRequest).toHaveBeenCalledWith(payload);
    });

    test('should return error for invalid request without commands', async () => {
      const payload = { worldInstanceId: 'world123' };

      const result = await commandProcessor.processCommands(payload);

      expect(result).toEqual({ error: 'Invalid request: commands array required' });
    });

    test('should return error for non-array commands', async () => {
      const payload = {
        commands: 'not an array',
        worldInstanceId: 'world123'
      };

      const result = await commandProcessor.processCommands(payload);

      expect(result).toEqual({ error: 'Invalid request: commands array required' });
    });

    test('should handle processing errors', async () => {
      const payload = {
        commands: {
          load: [{ entityType: 'player', worldId: 1 }]
        },
        worldInstanceId: 'world123'
      };

      commandProcessor.validateAndDecryptRequest.mockRejectedValueOnce(new Error('Validation failed'));

      await expect(commandProcessor.processCommands(payload)).rejects.toThrow('Validation failed');
    });
  });
});