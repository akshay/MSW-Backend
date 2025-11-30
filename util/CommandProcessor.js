// src/processors/CommandProcessor.js
import { precomputeSharedKey as box_before, openSecretBox as box_open_afternm } from '@stablelib/nacl';
import { encode as encodeBase64, decode as decodeBase64 } from '@stablelib/base64';
import { config } from '../config.js';
import { HybridCacheManager } from './HybridCacheManager.js';
import { StreamManager } from './StreamManager.js';
import { EphemeralEntityManager } from './EphemeralEntityManager.js';
import { PersistentEntityManager } from './PersistentEntityManager.js';
import { BackgroundPersistenceTask } from './BackgroundPersistenceTask.js';
import { BackblazeFileManager } from './BackblazeFileManager.js';
import { metrics } from './MetricsCollector.js';

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
    this.persistentManager = new PersistentEntityManager(this.cache, this.streamManager, this.ephemeralManager);

    // Initialize background persistence task
    this.backgroundTask = new BackgroundPersistenceTask(
      this.ephemeralManager,
      this.persistentManager,
      {
        intervalMs: 5000, // Run every 5 seconds
        batchSize: 500,   // Process 500 entities per batch
        lockTTL: 10       // Hold lock for 10 seconds max
      }
    );

    // Initialize Backblaze file manager if enabled
    this.fileManager = null;
    if (config.backblaze.enabled && config.backblaze.keyId && config.backblaze.key) {
      this.fileManager = new BackblazeFileManager(config.backblaze);
    }

    // Precompute decryption key from environment variables
    this.initializeDecryption();

    // Start background persistence task
    this.startBackgroundTasks();
  }

  async startBackgroundTasks() {
    console.log('Starting background tasks...');
    this.backgroundTask.start();

    // Initialize file manager if enabled
    if (this.fileManager) {
      try {
        await this.fileManager.initialize();
        console.log('Backblaze file manager initialized successfully');
      } catch (error) {
        console.error('Failed to initialize Backblaze file manager:', error);
        // Don't throw - file sync is optional
      }
    }
  }

  async stopBackgroundTasks() {
    console.log('Stopping background tasks...');
    if (this.backgroundTask) {
      this.backgroundTask.stop();
    }

    if (this.fileManager) {
      await this.fileManager.shutdown();
    }
  }

  getBackgroundTaskStats() {
    return this.backgroundTask ? this.backgroundTask.getStats() : null;
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
      // Track world instance request
      if (payload.worldInstanceId) {
        metrics.recordWorldInstanceRequest(payload.worldInstanceId);
      }

      // Validate and decrypt the request
      await this.validateAndDecryptRequest(payload);

      // Validate environment
      const { environment, commands } = payload;
      if (!environment || !config.allowedEnvironments.includes(environment)) {
        return {
          error: `Invalid environment: must be one of ${config.allowedEnvironments.join(', ')}`,
          provided: environment
        };
      }

      if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
        return { error: 'Invalid request: commands array required' };
      }

      // Store environment for use in command processing
      this.currentEnvironment = environment;

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
        this.processBatchedGetRankings(commands.top || []),
        this.processBatchedClientMetrics(commands.emit || [])
      ]);

      // Reconstruct results in original command order
      const flatResults = results.flat();
      const orderedResults = this.reconstructOrderedResults(commands, flatResults);

      const processingTime = performance.now() - startTime;

      // Record command metrics
      const commandCounts = {
        load: commands.load?.length || 0,
        save: commands.save?.length || 0,
        send: commands.send?.length || 0,
        recv: commands.recv?.length || 0,
        search: commands.search?.length || 0,
        rank: commands.rank?.length || 0,
        top: commands.top?.length || 0,
        emit: commands.emit?.length || 0
      };

      Object.entries(commandCounts).forEach(([type, count]) => {
        if (count > 0) {
          const avgDuration = processingTime / Object.values(commandCounts).reduce((a, b) => a + b, 0);
          metrics.recordCommand(type, true, avgDuration, payload.worldInstanceId);
        }
      });

      // Handle file sync if files parameter is present
      const response = { ...orderedResults };

      if (this.fileManager && payload.files) {
        const fileSyncData = await this.processFileSync(
          environment,
          payload.files,
          payload.downloads
        );

        if (fileSyncData.fileMismatches) {
          response.fileMismatches = fileSyncData.fileMismatches;
        }

        if (fileSyncData.fileDownloads) {
          response.fileDownloads = fileSyncData.fileDownloads;
        }
      }

      return response;
    } catch (error) {
      console.error('Command processing failed:', error);

      // Record error metric
      const duration = performance.now() - startTime;
      metrics.recordCommand('unknown', false, duration, payload.worldInstanceId);

      throw error;
    }
  }

  async validateAndDecryptRequest(payload) {
    const { encrypted, nonce, worldInstanceId, auth } = payload;

    // 1. Validate auth matches expected public key
    if (auth !== this.expectedAuth) {
      throw new Error('Authentication failed: invalid auth token');
    }

    // 2. Validate encrypted string
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
        if (sequenceNumber <= currentSequence) {
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

      // Validate that commands[cmd] is an array
      if (!Array.isArray(array)) {
        throw new Error(`Commands must be an array for type: ${cmd}`);
      }

      for (let i = 0; i < array.length; i++) {
        const command = array[i];

        // Validate that command is an object
        if (typeof command !== 'object' || command === null) {
          throw new Error(`Command ${i} must be an object`);
        }

        command.originalIndex = i;
        command.type = cmd;
        command.worldInstanceId = worldInstanceId;

        // Validate required fields (skip for emit commands which have different structure)
        if (cmd !== 'emit') {
          if (!command.entityType) {
            throw new Error(`Command ${i}: entityType is required`);
          }

          if (command.worldId === undefined || command.worldId === null) {
            throw new Error(`Command ${i}: worldId is required`);
          }
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
      environment: this.currentEnvironment,
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
      environment: this.currentEnvironment,
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
      environment: this.currentEnvironment,
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
        if (key.startsWith('rank') || key.startsWith('score') || key.endsWith('Score') || key.endsWith('Rank')) {
          rankScores[key] = attributes[key];
          delete attributes[key];
        }
      });

      return {
        environment: this.currentEnvironment,
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
    const results = await this.ephemeralManager.batchSavePartial(updates);

    return commands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'save',
      result: results[index]
    }));
  }

  async processBatchedStreamAdds(streamAddCommands) {
    if (streamAddCommands.length === 0) return [];

    // Add environment to commands
    const commandsWithEnv = streamAddCommands.map(cmd => ({
      ...cmd,
      environment: this.currentEnvironment
    }));

    const results = await this.streamManager.batchAddMessages(commandsWithEnv);

    return streamAddCommands.map((cmd, index) => ({
      originalIndex: cmd.originalIndex,
      type: 'send',
      result: results[index]
    }));
  }

  async processBatchedStreamPulls(streamPullCommands) {
    if (streamPullCommands.length === 0) return [];

    // Add environment to commands
    const commandsWithEnv = streamPullCommands.map(cmd => ({
      ...cmd,
      environment: this.currentEnvironment
    }));

    const results = await this.streamManager.batchPullMessages(commandsWithEnv);

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
      environment: this.currentEnvironment,
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
      environment: this.currentEnvironment,
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
      environment: this.currentEnvironment,
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

  async processBatchedClientMetrics(clientMetricsCommands) {
    if (clientMetricsCommands.length === 0) return [];

    const results = [];

    for (const cmd of clientMetricsCommands) {
      try {
        // Validate metrics array structure
        if (!Array.isArray(cmd.metrics)) {
          throw new Error('metrics must be an array');
        }

        // Process each metric in the command
        for (const metric of cmd.metrics) {
          // Validate metric structure
          if (!metric.group || typeof metric.group !== 'string') {
            throw new Error('Each metric must have a "group" (string)');
          }
          if (typeof metric.value !== 'number') {
            throw new Error('Each metric must have a "value" (number)');
          }

          // Record the client metric
          metrics.recordClientMetric(
            metric.group,
            metric.value,
            metric.tags || {},
            cmd.worldInstanceId
          );
        }

        results.push({
          originalIndex: cmd.originalIndex,
          type: 'emit',
          result: { success: true, count: cmd.metrics.length }
        });
      } catch (error) {
        results.push({
          originalIndex: cmd.originalIndex,
          type: 'emit',
          result: { success: false, error: error.message }
        });
      }
    }

    return results;
  }

  isEphemeralEntityType(entityType) {
    return config.entityTypes.ephemeral.includes(entityType);
  }

  /**
   * Process file sync operations
   * - Validates file hashes
   * - Returns file mismatches
   * - Handles progressive file downloads with offset support
   * - Respects 10MB response limit
   */
  async processFileSync(environment, fileHashes, downloads) {
    const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
    const BANDWIDTH_ALLOCATION = 0.9; // Use 90% of available bandwidth

    const result = {
      fileMismatches: null,
      fileDownloads: null,
    };

    try {
      // Step 1: Validate file hashes and identify mismatches
      const mismatches = this.fileManager.validateFileHashes(environment, fileHashes);

      if (Object.keys(mismatches).length > 0) {
        result.fileMismatches = mismatches;
        metrics.recordMetric('file_sync.mismatches', Object.keys(mismatches).length);
      }

      // Step 2: Process downloads if requested
      if (downloads && Object.keys(downloads).length > 0) {
        const downloadResults = {};
        let remainingBandwidth = MAX_RESPONSE_SIZE * BANDWIDTH_ALLOCATION;

        // Sort downloads to process them in a consistent order
        const downloadEntries = Object.entries(downloads).sort(([a], [b]) => a.localeCompare(b));

        for (const [fileName, downloadInfo] of downloadEntries) {
          if (remainingBandwidth <= 0) {
            // No more bandwidth available
            break;
          }

          // Validate that the hash matches the current file version
          const cachedFile = this.fileManager.getFile(environment, fileName);

          if (!cachedFile) {
            // File not found
            downloadResults[fileName] = {
              error: 'File not found',
            };
            continue;
          }

          if (downloadInfo.hash !== cachedFile.hash) {
            // Hash mismatch - client is requesting wrong version
            downloadResults[fileName] = {
              error: 'Hash mismatch',
              expectedHash: cachedFile.hash,
              fileSize: cachedFile.fileSize,
            };
            continue;
          }

          // Get the current offset (how many bytes already downloaded)
          const offset = downloadInfo.bytesReceived || 0;

          // Get file chunk with bandwidth limit
          const chunkData = this.fileManager.getFileChunk(
            environment,
            fileName,
            offset,
            Math.floor(remainingBandwidth)
          );

          if (!chunkData) {
            downloadResults[fileName] = {
              error: 'Failed to read file',
            };
            continue;
          }

          // Convert buffer to base64 for JSON transport
          const chunkBase64 = chunkData.chunk.toString('base64');

          downloadResults[fileName] = {
            hash: chunkData.hash,
            fileSize: chunkData.fileSize,
            offset: chunkData.offset,
            bytesInChunk: chunkData.bytesToSend,
            remainingBytes: chunkData.remainingBytes,
            chunk: chunkBase64,
            complete: chunkData.remainingBytes === 0,
          };

          // Update remaining bandwidth
          remainingBandwidth -= chunkData.bytesToSend;

          // Record metrics
          metrics.recordMetric('file_sync.bytes_sent', chunkData.bytesToSend);
        }

        if (Object.keys(downloadResults).length > 0) {
          result.fileDownloads = downloadResults;
        }
      }

      return result;
    } catch (error) {
      console.error('[CommandProcessor] Error processing file sync:', error);
      metrics.recordError('file_sync', error);
      return {
        fileMismatches: null,
        fileDownloads: null,
        error: 'File sync error',
      };
    }
  }

  /**
   * Get file manager stats
   */
  getFileSyncStats() {
    return this.fileManager ? this.fileManager.getStats() : null;
  }
}
