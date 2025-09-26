// src/processors/CommandProcessor.js
import * as nacl from 'tweetnacl';
import { config } from '../config.js';
import { HybridCacheManager } from './HybridCacheManager.js';
import { StreamManager } from './StreamManager.js';
import { EphemeralEntityManager } from './EphemeralEntityManager.js';
import { PersistentEntityManager } from './PersistentEntityManager.js';

export class CommandProcessor {
  constructor() {
    this.cache = new HybridCacheManager();
    this.streamManager = new StreamManager();
    this.ephemeralManager = new EphemeralEntityManager(this.streamManager);
    this.persistentManager = new PersistentEntityManager(this.cache, this.streamManager);
    
    // Precompute decryption key from environment variables
    this.initializeDecryption();
  }

  initializeDecryption() {
    try {
      const senderPublicKey = process.env.SENDER_PUBLIC_KEY;
      const recipientPrivateKey = process.env.RECIPIENT_PRIVATE_KEY;

      if (!senderPublicKey || !recipientPrivateKey) {
        throw new Error('SENDER_PUBLIC_KEY and RECIPIENT_PRIVATE_KEY environment variables are required');
      }

      // Store for auth validation
      this.expectedAuth = senderPublicKey;

      // Convert base64 keys to Uint8Array for NaCl
      this.senderPublicKeyBytes = nacl.util.decodeBase64(senderPublicKey);
      this.recipientPrivateKeyBytes = nacl.util.decodeBase64(recipientPrivateKey);

      // Precompute the shared secret for Box decryption
      this.sharedSecret = nacl.box.before(this.senderPublicKeyBytes, this.recipientPrivateKeyBytes);

      console.log('NaCl decryption initialized successfully');
    } catch (error) {
      console.error('Failed to initialize NaCl decryption:', error);
      throw error;
    }
  }

  async processCommands(payload) {
    const startTime = performance.now();
    
    try {
      // Validate and decrypt the request
      await this.validateAndDecryptRequest(payload);

      const { commands } = payload;
      if (!commands || !Array.isArray(commands)) {
        return { error: 'Invalid request: commands array required' };
      }
      
      // Group commands by type for optimal batching
      const commandGroups = this.groupCommandsByType(commands, payload.worldInstanceId);
      
      // Process all command groups in parallel
      const results = await Promise.all([
        this.processBatchedLoads(commandGroups.loads || []),
        this.processBatchedSaves(commandGroups.saves || []),
        this.processBatchedStreamAdds(commandGroups.streamAdds || []),
        this.processBatchedStreamPulls(commandGroups.streamPulls || [])
      ]);
      
      // Reconstruct results in original command order
      const orderedResults = this.reconstructOrderedResults(commands, results.flat());
      
      const processingTime = performance.now() - startTime;
      console.log(`Processed ${commands.length} commands in ${processingTime}ms`);
      
      return orderedResults;
    } catch (error) {
      console.error('Command processing failed:', error);
      throw error;
    }
  }

  async validateAndDecryptRequest(payload) {
    const { encrypted, nonce, worldInstanceId, auth } = payload;

    // 1. Validate auth matches expected public key
    if (auth !== this.expectedAuth) {
      throw new Error('Authentication failed: invalid auth token');
    }

    // 2. Validate encrypted string length
    if (!encrypted || encrypted.length !== 24) {
      throw new Error('Invalid encrypted string: must be exactly 24 characters');
    }

    // 3. Decode and validate nonce
    if (!nonce) {
      throw new Error('Nonce is required');
    }

    let nonceBytes;
    try {
      nonceBytes = nacl.util.decodeBase64(nonce);
    } catch (error) {
      throw new Error('Invalid nonce: must be valid base64');
    }

    if (nonceBytes.length !== 24) {
      throw new Error('Invalid nonce: decoded bytes must be exactly 24 bytes');
    }

    // 4. Extract sequence number, random, and elapsed time from nonce
    const sequenceNumber = this.readLittleEndianUint64(nonceBytes, 0);
    const randomNumber = this.readLittleEndianUint64(nonceBytes, 8);
    const elapsedSeconds = this.readLittleEndianUint64(nonceBytes, 16);

    console.log(`Nonce decoded - Sequence: ${sequenceNumber}, Random: ${randomNumber}, Elapsed: ${elapsedSeconds}`);

    // 5. Validate sequence number is strictly increasing
    await this.validateSequenceNumber(worldInstanceId, sequenceNumber);

    // 6. Decrypt the encrypted string using NaCl Box
    let decryptedBytes;
    try {
      const encryptedBytes = nacl.util.decodeUTF8(encrypted);
      decryptedBytes = nacl.box.open.after(encryptedBytes, nonceBytes, this.sharedSecret);
      
      if (!decryptedBytes) {
        throw new Error('Decryption failed');
      }
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }

    // 7. Verify decrypted content matches worldInstanceId
    const decryptedString = nacl.util.encodeUTF8(decryptedBytes);
    if (decryptedString !== worldInstanceId) {
      throw new Error('Decryption verification failed: content does not match worldInstanceId');
    }

    console.log(`Request validated successfully for worldInstanceId: ${worldInstanceId}`);
  }

  // Helper function to read 64-bit little-endian integers from byte array
  readLittleEndianUint64(bytes, offset) {
    let result = 0;
    for (let i = 0; i < 8; i++) {
      result += bytes[offset + i] * Math.pow(256, i);
    }
    return result;
  }

  async validateSequenceNumber(worldInstanceId, sequenceNumber) {
    const cacheKey = `sequence:${worldInstanceId}`;
    
    try {
      // Get current sequence number from cache
      const currentSequence = await this.cache.get(cacheKey);
      
      if (currentSequence !== null) {
        // Sequence number must be strictly increasing
        if (sequenceNumber <= currentSequence) {
          throw new Error(`Invalid sequence number: ${sequenceNumber} must be greater than ${currentSequence}`);
        }
      }

      // Update cache with new sequence number (5 second TTL)
      await this.cache.set(cacheKey, sequenceNumber, 5);

      console.log(`Sequence number validated: ${sequenceNumber} for worldInstanceId: ${worldInstanceId}`);
    } catch (error) {
      if (error.message.includes('Invalid sequence number')) {
        throw error;
      }
      throw new Error(`Sequence number validation failed: ${error.message}`);
    }
  }

  groupCommandsByType(commands, worldInstanceId) {
    return commands.reduce((groups, command, index) => {
      command.originalIndex = index;
      
      // Validate required fields
      if (!command.entityType) {
        throw new Error(`Command ${index}: entityType is required`);
      }
      
      if (command.worldId === undefined || command.worldId === null) {
        throw new Error(`Command ${index}: worldId is required`);
      }
      
      switch(command.type) {
        case 'load_entity':
          (groups.loads = groups.loads || []).push(command);
          break;
        case 'save_entity':
          (groups.saves = groups.saves || []).push(command);
          break;
        case 'add_to_stream':
          (groups.streamAdds = groups.streamAdds || []).push(command);
          break;
        case 'pull_from_stream':
          // Add worldInstanceId from request level to each pull command
          command.worldInstanceId = worldInstanceId;
          (groups.streamPulls = groups.streamPulls || []).push(command);
          break;
      }
      
      return groups;
    }, {});
  }

  async processBatchedLoads(loadCommands) {
    if (loadCommands.length === 0) return [];

    // Separate ephemeral from persistent entities
    const ephemeralLoads = [];
    const persistentLoads = [];

    loadCommands.forEach(cmd => {
      if (this.isEphemeralEntityType(cmd.entityType)) {
        ephemeralLoads.push(cmd);
      } else {
        persistentLoads.push(cmd);
      }
    });

    // Process both types in parallel
    const [ephemeralResults, persistentResults] = await Promise.all([
      this.processEphemeralLoads(ephemeralLoads),
      this.processPersistentLoads(persistentLoads)
    ]);

    return [...ephemeralResults, ...persistentResults];
  }

  async processEphemeralLoads(commands) {
    if (commands.length === 0) return [];

    const loadRequests = commands.map(cmd => ({
      entityType: cmd.entityType,
      entityId: cmd.entityId,
      worldId: cmd.worldId
    }));

    const entities = await this.ephemeralManager.batchLoad(loadRequests);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'load_entity',
      result: entities[index]
    }));
  }

  async processPersistentLoads(commands) {
    if (commands.length === 0) return [];

    const loadRequests = commands.map(cmd => ({
      entityType: cmd.entityType,
      entityId: cmd.entityId,
      worldId: cmd.worldId
    }));

    const entities = await this.persistentManager.batchLoad(loadRequests);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'load_entity',
      result: entities[index]
    }));
  }

  async processBatchedSaves(saveCommands) {
    if (saveCommands.length === 0) return [];

    // Separate ephemeral from persistent entities
    const ephemeralSaves = [];
    const persistentSaves = [];

    saveCommands.forEach(cmd => {
      if (this.isEphemeralEntityType(cmd.entityType)) {
        ephemeralSaves.push(cmd);
      } else {
        persistentSaves.push(cmd);
      }
    });

    // Process both types in parallel (both auto-add to streams)
    const [ephemeralResults, persistentResults] = await Promise.all([
      this.processEphemeralSaves(ephemeralSaves),
      this.processPersistentSaves(persistentSaves)
    ]);

    return [...ephemeralResults, ...persistentResults];
  }

  async processEphemeralSaves(commands) {
    if (commands.length === 0) return [];

    const updates = commands.map(cmd => ({
      entityType: cmd.entityType,
      entityId: cmd.entityId,
      worldId: cmd.worldId,
      attributes: cmd.attributes
    }));

    // This automatically adds to streams via EphemeralEntityManager
    const results = await this.ephemeralManager.batchSavePartial(updates);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'save_entity',
      result: results[index]
    }));
  }

  async processPersistentSaves(commands) {
    if (commands.length === 0) return [];

    const updates = commands.map(cmd => {
      // Extract rank scores from attributes if present
      const rankScores = {};
      const attributes = { ...cmd.attributes };

      // Look for rank score patterns and extract them
      Object.keys(attributes).forEach(key => {
        if (key.startsWith('rank_') || key.endsWith('_score') || key.endsWith('_rank')) {
          rankScores[key] = attributes[key];
          delete attributes[key];
        }
      });

      return {
        entityType: cmd.entityType,
        entityId: cmd.entityId,
        worldId: cmd.worldId,
        attributes,
        rankScores: Object.keys(rankScores).length > 0 ? rankScores : null
      };
    });

    // This automatically adds to streams via PersistentEntityManager
    const results = await this.persistentManager.batchSavePartial(updates);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'save_entity',
      result: results[index]
    }));
  }

  async processBatchedStreamAdds(streamAddCommands) {
    if (streamAddCommands.length === 0) return [];

    const results = await this.streamManager.batchAddMessages(streamAddCommands);

    return streamAddCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'add_to_stream',
      result: results[index]
    }));
  }

  async processBatchedStreamPulls(streamPullCommands) {
    if (streamPullCommands.length === 0) return [];

    const results = await this.streamManager.batchPullMessages(streamPullCommands);

    return streamPullCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'pull_from_stream',
      result: results[index]
    }));
  }

  reconstructOrderedResults(originalCommands, batchResults) {
    const resultMap = new Map();
    batchResults.forEach(result => {
      resultMap.set(result.originalIndex, result.result);
    });

    return originalCommands.map((_, index) => resultMap.get(index));
  }

  isEphemeralEntityType(entityType) {
    return config.entityTypes.ephemeral.includes(entityType);
  }
}
