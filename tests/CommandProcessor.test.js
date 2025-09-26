// tests/CommandProcessor.test.js

// Mock dependencies
const mockCache = {
  get: jest.fn(),
  set: jest.fn()
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
  batchLoad: jest.fn(),
  batchSavePartial: jest.fn()
};

// Mock the classes that CommandProcessor imports first
jest.mock('../cloud/util/StreamManager.js', () => ({
  StreamManager: jest.fn(() => ({
    batchAddToStreams: jest.fn(),
    batchAddMessages: jest.fn(),
    batchPullMessages: jest.fn()
  }))
}));

jest.mock('../cloud/util/EphemeralEntityManager.js', () => ({
  EphemeralEntityManager: jest.fn(() => ({
    batchLoad: jest.fn(),
    batchSavePartial: jest.fn()
  }))
}));

jest.mock('../cloud/util/PersistentEntityManager.js', () => ({
  PersistentEntityManager: jest.fn(() => ({
    batchLoad: jest.fn(),
    batchSavePartial: jest.fn()
  }))
}));

jest.mock('../cloud/config.js', () => ({
  config: {
    entityTypes: {
      ephemeral: ['session', 'temporary_data']
    }
  }
}));

// Mock HybridCacheManager
jest.mock('../cloud/util/HybridCacheManager.js', () => ({
  HybridCacheManager: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn()
  }))
}));

const mockConfig = {
  entityTypes: {
    ephemeral: ['session', 'temporary_data']
  }
};

import { CommandProcessor } from '../util/CommandProcessor.js';
import * as nacl from 'tweetnacl';

// Mock nacl functions
jest.mock('tweetnacl', () => ({
  util: {
    decodeBase64: jest.fn(),
    decodeUTF8: jest.fn(),
    encodeUTF8: jest.fn()
  },
  box: {
    before: jest.fn(),
    open: {
      after: jest.fn()
    }
  }
}));

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

    // Mock nacl functions
    nacl.util.decodeBase64.mockReturnValue(new Uint8Array(32));
    nacl.box.before.mockReturnValue(new Uint8Array(32));

    commandProcessor = new CommandProcessor();
    
    // Wire up the mock cache to the instance
    commandProcessor.cache = mockCache;
    commandProcessor.ephemeralManager = mockEphemeralManager;
    commandProcessor.persistentManager = mockPersistentManager;
    commandProcessor.streamManager = mockStreamManager;
    
    // Clear mocks AFTER instance creation, but verify nacl was called during construction
    const naclDecodeCalls = nacl.util.decodeBase64.mock.calls.length;
    const naclBoxCalls = nacl.box.before.mock.calls.length;
    
    jest.clearAllMocks();
    
    // Restore the call counts for constructor test verification
    if (naclDecodeCalls > 0) {
      nacl.util.decodeBase64.mockReturnValue(new Uint8Array(32));
      // Mark that nacl.util.decodeBase64 was called during construction
      nacl.util.decodeBase64.wasCalledDuringConstruction = true;
    }
    if (naclBoxCalls > 0) {
      nacl.box.before.mockReturnValue(new Uint8Array(32));
      // Mark that nacl.box.before was called during construction
      nacl.box.before.wasCalledDuringConstruction = true;
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
      expect(nacl.util.decodeBase64.wasCalledDuringConstruction).toBe(true);
      expect(nacl.box.before.wasCalledDuringConstruction).toBe(true);
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
      nacl.util.decodeBase64.mockImplementation((input) => {
        if (input === validPayload.nonce) {
          return new Uint8Array(24); // Return 24 bytes for nonce
        }
        return new Uint8Array(32); // Default for keys
      });

      // Mock successful decryption
      nacl.util.decodeUTF8.mockReturnValue(new Uint8Array(24));
      nacl.box.open.after.mockReturnValue(new Uint8Array(Array.from('world123', c => c.charCodeAt(0))));
      nacl.util.encodeUTF8.mockReturnValue('world123');

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

    test('should reject invalid encrypted string length', async () => {
      const invalidPayload = { ...validPayload, encrypted: 'short' };

      await expect(
        commandProcessor.validateAndDecryptRequest(invalidPayload)
      ).rejects.toThrow('Invalid encrypted string: must be exactly 24 characters');
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
      nacl.util.decodeBase64.mockImplementation((input) => {
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
      nacl.box.open.after.mockReturnValue(null);

      const testPayload = {
        ...validPayload,
        encrypted: 'validencryptedstring24!!' // Ensure encrypted passes length check (24 chars)
      };

      await expect(
        commandProcessor.validateAndDecryptRequest(testPayload)
      ).rejects.toThrow('Decryption failed');
    });

    test('should reject mismatched decrypted content', async () => {
      nacl.util.encodeUTF8.mockReturnValue('wrong_world_id');

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
      const commands = [
        { type: 'load_entity', entityType: 'player', worldId: 1 },
        { type: 'save_entity', entityType: 'player', worldId: 1 },
        { type: 'load_entity', entityType: 'guild', worldId: 1 },
        { type: 'add_to_stream', entityType: 'chat', worldId: 1 },
        { type: 'pull_from_stream', entityType: 'events', worldId: 1 }
      ];

      const result = commandProcessor.groupCommandsByType(commands, 'world123');

      expect(result.loads).toHaveLength(2);
      expect(result.saves).toHaveLength(1);
      expect(result.streamAdds).toHaveLength(1);
      expect(result.streamPulls).toHaveLength(1);
      expect(result.streamPulls[0].worldInstanceId).toBe('world123');
    });

    test('should validate required fields', () => {
      const invalidCommands = [
        { type: 'load_entity', worldId: 1 }, // missing entityType
        { type: 'save_entity', entityType: 'player' } // missing worldId
      ];

      expect(() => {
        commandProcessor.groupCommandsByType([invalidCommands[0]], 'world123');
      }).toThrow('Command 0: entityType is required');

      expect(() => {
        commandProcessor.groupCommandsByType([invalidCommands[1]], 'world123');
      }).toThrow('Command 0: worldId is required');
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
        { entityType: 'session', originalIndex: 0 },
        { entityType: 'player', originalIndex: 1 }
      ];

      // Mock the managers to return the correct number of results
      mockEphemeralManager.batchLoad.mockResolvedValueOnce([{ id: 'sess1' }]);
      mockPersistentManager.batchLoad.mockResolvedValueOnce([{ id: 'player1' }]);

      const result = await commandProcessor.processBatchedLoads(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'load_entity',
        result: { id: 'sess1' }
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'load_entity',
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
        { entityType: 'session', attributes: { active: true }, originalIndex: 0 },
        { entityType: 'player', attributes: { level: 10, rank_combat: 100 }, originalIndex: 1 }
      ];

      // Mock the managers to return the correct number of results
      mockEphemeralManager.batchSavePartial.mockResolvedValueOnce([{ success: true }]);
      mockPersistentManager.batchSavePartial.mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedSaves(commands);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'save_entity',
        result: { success: true }
      });
      expect(result[1]).toEqual({
        originalIndex: 1,
        type: 'save_entity',
        result: { success: true }
      });
      expect(mockEphemeralManager.batchSavePartial).toHaveBeenCalled();
      expect(mockPersistentManager.batchSavePartial).toHaveBeenCalled();
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
          originalIndex: 0
        }
      ];

      mockPersistentManager.batchSavePartial.mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedSaves(commands);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        originalIndex: 0,
        type: 'save_entity',
        result: { success: true }
      });
      expect(mockPersistentManager.batchSavePartial).toHaveBeenCalledWith([{
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
        { streamId: 'chat1', messages: ['hello'], originalIndex: 0 }
      ];

      mockStreamManager.batchAddMessages.mockResolvedValueOnce([{ success: true }]);

      const result = await commandProcessor.processBatchedStreamAdds(commands);

      expect(result).toEqual([{
        originalIndex: 0,
        type: 'add_to_stream',
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
        { streamId: 'events1', timestamp: '0-0', originalIndex: 0 }
      ];

      mockStreamManager.batchPullMessages.mockResolvedValueOnce([{ 
        success: true, 
        data: [{ id: '1', data: 'event' }] 
      }]);

      const result = await commandProcessor.processBatchedStreamPulls(commands);

      expect(result).toEqual([{
        originalIndex: 0,
        type: 'pull_from_stream',
        result: { success: true, data: [{ id: '1', data: 'event' }] }
      }]);
      expect(mockStreamManager.batchPullMessages).toHaveBeenCalledWith(commands);
    });
  });

  describe('reconstructOrderedResults', () => {
    test('should reconstruct results in original command order', () => {
      const originalCommands = [{}, {}, {}]; // 3 commands
      const batchResults = [
        { originalIndex: 2, result: 'third' },
        { originalIndex: 0, result: 'first' },
        { originalIndex: 1, result: 'second' }
      ];

      const result = commandProcessor.reconstructOrderedResults(originalCommands, batchResults);

      expect(result).toEqual(['first', 'second', 'third']);
    });

    test('should handle missing results', () => {
      const originalCommands = [{}, {}];
      const batchResults = [
        { originalIndex: 0, result: 'first' }
        // Missing result for index 1
      ];

      const result = commandProcessor.reconstructOrderedResults(originalCommands, batchResults);

      expect(result).toEqual(['first', undefined]);
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
    });

    test('should process valid command payload', async () => {
      const payload = {
        commands: [
          { type: 'load_entity', entityType: 'player', worldId: 1 }
        ],
        worldInstanceId: 'world123'
      };

      jest.spyOn(commandProcessor, 'processBatchedLoads').mockResolvedValueOnce([
        { originalIndex: 0, type: 'load_entity', result: { id: 'player1' } }
      ]);

      const result = await commandProcessor.processCommands(payload);

      expect(result).toEqual([{ id: 'player1' }]);
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
        commands: [
          { type: 'load_entity', entityType: 'player', worldId: 1 }
        ],
        worldInstanceId: 'world123'
      };

      commandProcessor.validateAndDecryptRequest.mockRejectedValueOnce(new Error('Validation failed'));

      await expect(commandProcessor.processCommands(payload)).rejects.toThrow('Validation failed');
    });
  });
});