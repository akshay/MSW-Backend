// src/processors/CommandProcessor.js
import { precomputeSharedKey as box_before, openSecretBox as box_open_afternm } from '@stablelib/nacl';
import { encode as encodeBase64, decode as decodeBase64 } from '@stablelib/base64';
import { config } from '../config.js';
import { HybridCacheManager } from './HybridCacheManager.js';
import { StreamManager } from './StreamManager.js';
import { EphemeralEntityManager } from './EphemeralEntityManager.js';
import { PersistentEntityManager } from './PersistentEntityManager.js';

// Simple ASCII encode/decode functions for authentication
export function encodeAscii(str) {
  const buffer = new ArrayBuffer(str.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

export function decodeAscii(bytes) {
  return String.fromCharCode(...bytes);
}

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
      this.senderPublicKeyBytes = decodeBase64(senderPublicKey);
      this.recipientPrivateKeyBytes = decodeBase64(recipientPrivateKey);

      // Precompute the shared secret for NaCl Box decryption
      this.sharedSecret = box_before(this.senderPublicKeyBytes, this.recipientPrivateKeyBytes);

      //console.log('NaCl decryption initialized successfully');
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
      if (!commands) {
        return { error: 'Invalid request: commands array required' };
      }
      
      // Group commands by type for optimal batching
      this.groupCommandsByType(commands, payload.worldInstanceId);
      
      // Process all command groups in parallel
      const results = await Promise.all([
        this.processBatchedLoads(commands.load || []),
        this.processBatchedSaves(commands.save || []),
        this.processBatchedStreamAdds(commands.send || []),
        this.processBatchedStreamPulls(commands.recv || []),
        this.processBatchedSearchByName(commands.search || []),
        this.processBatchedCalculateRank(commands.rank || []),
        this.processBatchedGetRankings(commands.top || [])
      ]);
      
      // Reconstruct results in original command order
      const flatResults = results.flat();
      const orderedResults = this.reconstructOrderedResults(commands, flatResults);
      
      const processingTime = performance.now() - startTime;
      // console.log(`Processed ${flatResults.length} commands in ${processingTime}ms`);
      
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
    if (!encrypted) {
      throw new Error('Invalid encrypted string: must be provided');
    }

    // 3. Decode and validate nonce
    if (!nonce) {
      throw new Error('Nonce is required');
    }

    let nonceBytes;
    try {
      nonceBytes = decodeBase64(nonce);
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

    // console.log(`Nonce decoded - Sequence: ${sequenceNumber}, Random: ${randomNumber}, Elapsed: ${elapsedSeconds}`);

    // 5. Validate sequence number is strictly increasing
    await this.validateSequenceNumber(worldInstanceId, sequenceNumber);

    // 6. Decrypt the encrypted string using NaCl Box
    let decryptedBytes;
    try {
      const encryptedBytes = decodeBase64(encrypted);
      // console.log(encryptedBytes);
      decryptedBytes = box_open_afternm(this.sharedSecret, nonceBytes, encryptedBytes);
    } catch (error) {
      throw new Error(`Decryption failed: ${error.message}`);
    }

    if (!decryptedBytes) {
      throw new Error('Decryption failed');
    }

    // 7. Verify decrypted content matches worldInstanceId
    const decryptedString = decodeAscii(decryptedBytes);
    if (decryptedString !== worldInstanceId) {
      throw new Error('Decryption verification failed: content does not match worldInstanceId');
    }

    // console.log(`Request validated successfully for worldInstanceId: ${worldInstanceId}`);
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
        if (sequenceNumber < currentSequence) {
          throw new Error(`Invalid sequence number: ${sequenceNumber} must be greater than ${currentSequence}`);
        }
      }

      // Update cache with new sequence number (5 second TTL)
      await this.cache.set(cacheKey, sequenceNumber, this.cache.defaultTTL / 100);

      // console.log(`Sequence number validated: ${sequenceNumber} for worldInstanceId: ${worldInstanceId}`);
    } catch (error) {
      if (error.message.includes('Invalid sequence number')) {
        throw error;
      }
      throw new Error(`Sequence number validation failed: ${error.message}`);
    }
  }

  groupCommandsByType(commands, worldInstanceId) {
    for (const cmd of Object.keys(commands)) {
      let array = commands[cmd];
      for (let i = 0; i < array.length; i++) {
        const command = array[i];
        command.originalIndex = i;
        command.type = cmd;
        command.worldInstanceId = worldInstanceId;
      
        // Validate required fields
        if (!command.entityType) {
          throw new Error(`Command ${index}: entityType is required`);
        }
        
        if (command.worldId === undefined || command.worldId === null) {
          throw new Error(`Command ${index}: worldId is required`);
        }
      }
    }
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
      type: 'load',
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
      type: 'load',
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
      attributes: cmd.attributes,
    }));

    // This automatically adds to streams via EphemeralEntityManager
    const results = await this.ephemeralManager.batchSavePartial(updates);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'save',
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
        rankScores: Object.keys(rankScores).length > 0 ? rankScores : null,
        isCreate: cmd.isCreate,
        isDelete: cmd.isDelete
      };
    });

    // This automatically adds to streams via PersistentEntityManager
    const results = await this.persistentManager.batchSavePartial(updates);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'save',
      result: results[index]
    }));
  }

  async processBatchedStreamAdds(streamAddCommands) {
    if (streamAddCommands.length === 0) return [];

    const results = await this.streamManager.batchAddMessages(streamAddCommands);

    return streamAddCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'send',
      result: results[index]
    }));
  }

  async processBatchedStreamPulls(streamPullCommands) {
    if (streamPullCommands.length === 0) return [];

    const results = await this.streamManager.batchPullMessages(streamPullCommands);

    return streamPullCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'recv',
      result: results[index]
    }));
  }

  async processBatchedSearchByName(searchCommands) {
    if (searchCommands.length === 0) return [];

    // Use batch method for efficient cache operations
    const requests = searchCommands.map(cmd => ({
      entityType: cmd.entityType,
      namePattern: cmd.namePattern,
      worldId: cmd.worldId,
      limit: cmd.limit || 100
    }));

    const results = await this.persistentManager.batchSearchByName(requests);

    return searchCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'search',
      result: results[index]
    }));
  }

  async processBatchedCalculateRank(calculateRankCommands) {
    if (calculateRankCommands.length === 0) return [];

    // Use batch method for efficient cache operations
    const requests = calculateRankCommands.map(cmd => ({
      entityType: cmd.entityType,
      worldId: cmd.worldId,
      entityId: cmd.entityId,
      rankKey: cmd.rankKey
    }));

    const results = await this.persistentManager.batchCalculateEntityRank(requests);

    return calculateRankCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'rank',
      result: results[index]
    }));
  }

  async processBatchedGetRankings(getRankingsCommands) {
    if (getRankingsCommands.length === 0) return [];

    // Use batch method for efficient cache operations
    const requests = getRankingsCommands.map(cmd => ({
      entityType: cmd.entityType,
      worldId: cmd.worldId,
      rankKey: cmd.rankKey,
      sortOrder: cmd.sortOrder || 'DESC',
      limit: cmd.limit || 100
    }));

    const results = await this.persistentManager.batchGetRankedEntities(requests);

    return getRankingsCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'top',
      result: results[index]
    }));
  }

  reconstructOrderedResults(originalCommands, batchResults) {
    const resultMap = {};

    for (let cmd of Object.keys(originalCommands)) {
      resultMap[cmd] = new Map();
    }

    batchResults.forEach(result => {
      resultMap[result.type].set(result.originalIndex, result.result);
    });

    const returnMap = {};
    for (let cmd of Object.keys(originalCommands)) {
      returnMap[cmd] = originalCommands[cmd].map((_, index) => resultMap[cmd].get(index));
    }
    return returnMap;
  }

  isEphemeralEntityType(entityType) {
    return config.entityTypes.ephemeral.includes(entityType);
  }
}
