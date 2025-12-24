// src/entities/EphemeralEntityManager.js
import { ephemeralRedis, config } from '../config.js';
import { InputValidator } from './InputValidator.js';
import { EntityDiffUtil } from './EntityDiffUtil.js';
import { KeyGenerator } from './KeyGenerator.js';
import { StreamUpdateUtil } from './StreamUpdateUtil.js';

export class EphemeralEntityManager {
  constructor(streamManager) {
    this.redis = ephemeralRedis;
    this.streamManager = streamManager;
    this.checkRedisJSONSupport();
    this.DIRTY_SET_KEY = 'ephemeral:dirty_entities'; // Set to track entities with pending updates
    this.VERSION_CACHE_TTL = 3600; // 1 hour TTL for versioned snapshots
    // Store the set of ephemeral-only entity types that should NOT be persisted
    this.ephemeralOnlyTypes = new Set(config.entityTypes?.ephemeral || []);
  }

  async checkRedisJSONSupport() {
    try {
      await this.redis.call('JSON.SET', 'test:support', '$', JSON.stringify({ test: true }));
      await this.redis.call('JSON.DEL', 'test:support');
      console.log('RedisJSON module detected for ephemeral entities');
    } catch (error) {
      console.error('RedisJSON module not available for ephemeral entities:', error);
      throw new Error('RedisJSON module required for ephemeral entity operations');
    }
  }

  // Check if an entity type is ephemeral-only (should not be persisted to DB)
  isEphemeralOnly(entityType) {
    return this.ephemeralOnlyTypes.has(entityType);
  }

  // Ephemeral key includes entityType and worldId
  // If version is provided, include it in the cache key
  getEphemeralKey(environment, entityType, entityId, worldId, version = null) {
    return KeyGenerator.getEphemeralKey(environment, entityType, entityId, worldId, version);
  }

  // Compute the difference between two entity versions
  // Returns only the attributes that changed
  computeEntityDiff(oldEntity, newEntity) {
    return EntityDiffUtil.computeEntityDiff(oldEntity, newEntity, { includeRankScores: false });
  }

  async batchSavePartial(updates) {
    if (updates.length === 0) return [];

    try {
      const timestamp = Date.now();

      // Check which entities exist (batch operation)
      const keys = updates.map(({ environment, entityType, entityId, worldId }) =>
        this.getEphemeralKey(environment, entityType, entityId, worldId)
      );

      const existsPipeline = this.redis.pipeline();
      keys.forEach(key => existsPipeline.call('JSON.TYPE', key));
      const existsResults = await existsPipeline.exec();
      const existsFlags = existsResults.map(([error, result]) => !!result && !error);

      // Process updates in optimized batches
      const batchSize = 5000; // Larger batches for better throughput
      const results = [];
      const streamUpdates = []; // Collect stream updates for batch processing

      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        const batchKeys = keys.slice(i, i + batchSize);
        const batchExists = existsFlags.slice(i, i + batchSize);

        const pipeline = this.redis.pipeline();
        const versionKeyIndices = []; // Track which pipeline commands are version increments
        const dirtyKeys = []; // Track keys to add to dirty set

        batch.forEach((update, batchIndex) => {
          const { environment, entityType, entityId, worldId, attributes, rankScores, isCreate = false, isDelete = false } = update;
          const key = batchKeys[batchIndex];
          const exists = batchExists[batchIndex];
          const versionKey = KeyGenerator.getVersionKey(environment, entityType, entityId, worldId);

          // Validation: Reject updates based on existence and flags
          if (!exists && !isCreate) {
            // Entity doesn't exist and isCreate is false - reject
            results[i + batchIndex] = {
              success: false,
              error: 'Entity does not exist and isCreate is false'
            };
            return;
          }

          if (!exists && isDelete) {
            // Entity doesn't exist and isDelete is true - reject
            results[i + batchIndex] = {
              success: false,
              error: 'Entity does not exist and isDelete is true'
            };
            return;
          }

          if (exists && isCreate) {
            // Entity exists and isCreate is true - reject
            results[i + batchIndex] = {
              success: false,
              error: 'Entity already exists and isCreate is true'
            };
            return;
          }

          // Track this entity as dirty for background persistence BEFORE the update
          // Skip ephemeral-only entity types that should not be persisted to DB
          // This MUST happen before the entity update to prevent race conditions
          if (!this.isEphemeralOnly(entityType)) {
            const dirtyKey = KeyGenerator.getDirtyKey(environment, entityType, entityId, worldId);
            dirtyKeys.push(dirtyKey);
            // Add to dirty set atomically with the update (for both updates and deletes)
            pipeline.sadd(this.DIRTY_SET_KEY, dirtyKey);
          }

          // Handle deletion
          if (isDelete) {
            // For non-ephemeral entities, mark as deleted but keep in Redis temporarily
            // so background task can persist the deletion to the database
            // For ephemeral-only entities, delete immediately
            if (this.isEphemeralOnly(entityType)) {
              // Delete the entity and its version counter immediately
              pipeline.call('JSON.DEL', key);
              pipeline.del(versionKey);
            } else {
              // Mark as deleted but keep the entity for background persistence
              pipeline.call('JSON.SET', key, '$.isDeleted', true);
              pipeline.call('JSON.SET', key, '$.lastWrite', timestamp);
              // Increment version to track the deletion
              const incrPosition = pipeline.length;
              versionKeyIndices.push({ index: incrPosition, batchIndex, isCreate: false });
              pipeline.incr(versionKey);
            }

            // Add deletion to stream
            streamUpdates.push({
              streamId: KeyGenerator.getStreamId(environment, entityType, worldId, entityId),
              data: { deleted: true }
            });

            return; // Skip further processing for this entity
          }

          // Separate attributes into updates and removals
          const attributesToSet = {};
          const attributesToRemove = [];
          const rankScoresToSet = {};
          const rankScoresToRemove = [];
          const streamData = {};

          // Process attributes
          Object.entries(attributes || {}).forEach(([field, value]) => {
            if (InputValidator.isNullMarker(value)) {
              // Mark for removal
              attributesToRemove.push(field);
            } else {
              // Mark for set
              attributesToSet[field] = value;
              streamData[field] = value;
            }
          });

          // Process rankScores (nested map structure)
          if (rankScores) {
            Object.entries(rankScores).forEach(([scoreType, partitionMap]) => {
              if (InputValidator.isNullMarker(partitionMap)) {
                // Remove entire score type
                rankScoresToRemove.push(scoreType);
              } else if (typeof partitionMap === 'object' && partitionMap !== null) {
                // Process partition map
                rankScoresToSet[scoreType] = partitionMap;
                // Add to stream data with flattened format "scoreType:partitionKey"
                Object.entries(partitionMap).forEach(([partitionKey, value]) => {
                  streamData[`${scoreType}:${partitionKey}`] = value;
                });
              }
            });
          }

          // Prepare stream update data (excluding NULL_MARKER values)
          streamUpdates.push({
            streamId: KeyGenerator.getStreamId(environment, entityType, worldId, entityId),
            data: streamData
          });

          if (isCreate) {
            // Create new entity (isCreate=true and entity doesn't exist, validated above)
            const newEntity = {
              id: entityId,
              entityType,
              worldId,
              attributes: attributesToSet,
              rankScores: rankScoresToSet,
              lastWrite: timestamp,
              version: 1,
              type: 'ephemeral'
            };

            pipeline.call('JSON.SET', key, '$', JSON.stringify(newEntity));
            // Set initial version counter
            pipeline.set(versionKey, '1');
            // Track this for versioned cache
            versionKeyIndices.push({ index: pipeline.length - 1, batchIndex, isCreate: true, version: 1 });
          } else {
            // Update existing entity attributes atomically (entity exists, validated above)

            // Set new/updated attributes
            Object.entries(attributesToSet).forEach(([field, value]) => {
              pipeline.call('JSON.SET', key, `$.attributes.${field}`, JSON.stringify(value));
            });

            // Remove attributes marked with NULL_MARKER
            attributesToRemove.forEach(field => {
              pipeline.call('JSON.DEL', key, `$.attributes.${field}`);
            });

            // Set new/updated rankScores (nested map structure)
            // For each scoreType, deep merge the partition map
            Object.entries(rankScoresToSet).forEach(([scoreType, partitionMap]) => {
              Object.entries(partitionMap).forEach(([partitionKey, value]) => {
                pipeline.call('JSON.SET', key, `$.rankScores.${scoreType}.${partitionKey}`, JSON.stringify(value));
              });
            });

            // Remove rankScores marked for deletion
            rankScoresToRemove.forEach(scoreType => {
              pipeline.call('JSON.DEL', key, `$.rankScores.${scoreType}`);
            });

            // Update worldId and timestamp
            pipeline.call('JSON.SET', key, '$.worldId', worldId);
            pipeline.call('JSON.SET', key, '$.lastWrite', timestamp);

            // Atomically increment version - track the position for extracting the new version
            const incrPosition = pipeline.length;
            versionKeyIndices.push({ index: incrPosition, batchIndex, isCreate: false });
            pipeline.incr(versionKey);
          }
        });

        // Execute pipeline and get version numbers
        const pipelineResults = await pipeline.exec();

        // Extract version numbers from results and update JSON atomically
        const versionUpdatePipeline = this.redis.pipeline();

        versionKeyIndices.forEach(({ index, batchIndex, isCreate, version: createVersion }) => {
          const [error, result] = pipelineResults[index];

          if (!error && result) {
            const versionNum = isCreate ? createVersion : parseInt(result);
            const update = batch[batchIndex];
            const { environment, entityType, entityId, worldId } = update;
            const key = batchKeys[batchIndex];

            // Update the version in the entity JSON atomically
            versionUpdatePipeline.call('JSON.SET', key, '$.version', versionNum);

            // Cache this version of the entity for future diff calculations with TTL
            const versionedKey = this.getEphemeralKey(environment, entityType, entityId, worldId, versionNum);
            versionUpdatePipeline.call('JSON.COPY', key, versionedKey);
            versionUpdatePipeline.expire(versionedKey, this.VERSION_CACHE_TTL);

            results[i + batchIndex] = { version: versionNum, success: true };
          } else {
            console.error(`Failed to get version for entity at index ${i + batchIndex}:`, error);
            results[i + batchIndex] = { version: 1, success: true, warning: 'version_update_failed' };
          }
        });

        // Execute version update pipeline with error handling
        try {
          await versionUpdatePipeline.exec();
        } catch (error) {
          console.error('Failed to update versions and cache versioned entities:', error);
          // Continue processing - entities are saved, just versioned cache failed
        }
      }

      return results;

    } catch (error) {
      console.error('Batch RedisJSON ephemeral save failed:', error);
      return updates.map(() => ({
        success: false,
        error: error.message
      }));
    }
  }

  async batchLoad(requests) {
    if (requests.length === 0) return [];

    try {
      // Prepare keys for both newest and versioned entities
      const newestKeys = [];
      const versionedKeys = [];
      const requestMeta = [];

      requests.forEach((request) => {
        const { environment, entityType, entityId, worldId, version = 0 } = request;
        const newestKey = this.getEphemeralKey(environment, entityType, entityId, worldId);
        const versionedKey = version > 0 ? this.getEphemeralKey(environment, entityType, entityId, worldId, version) : null;

        newestKeys.push(newestKey);
        versionedKeys.push(versionedKey);
        requestMeta.push({
          newestKey,
          versionedKey,
          hasVersion: version > 0
        });
      });

      // Create single combined pipeline for all Redis operations
      const combinedPipeline = this.redis.pipeline();

      // Add JSON.GET operations for newest entities
      newestKeys.forEach(key => {
        combinedPipeline.call('JSON.GET', key);
      });

      // Also get versioned entities if requested
      versionedKeys.forEach(key => {
        if (key) {
          combinedPipeline.call('JSON.GET', key);
        }
      });

      // Get world instance association keys
      const worldInstanceKeys = requests.map(({ environment, entityType, entityId, worldId }) => {
        return this.streamManager.getWorldInstanceKey(
          KeyGenerator.getStreamId(environment, entityType, worldId, entityId)
        );
      });

      // Add world instance keys to the same pipeline
      worldInstanceKeys.forEach(key => {
        combinedPipeline.get(key);
      });

      // Execute single pipeline
      const pipelineResults = await combinedPipeline.exec();

      // Parse results - split them based on what we requested
      const newestEntities = pipelineResults.slice(0, requests.length);
      const versionedCount = versionedKeys.filter(k => k !== null).length;
      const versionedEntities = pipelineResults.slice(requests.length, requests.length + versionedCount);
      const worldInstanceResults = pipelineResults.slice(requests.length + versionedCount);

      let versionedEntityIndex = 0;

      return requests.map((request, index) => {
        const [newestError, newestResult] = newestEntities[index];
        const [, worldInstanceId] = worldInstanceResults[index];
        const meta = requestMeta[index];

        if (newestError || !newestResult) {
          return null;
        }

        const newestEntity = JSON.parse(newestResult);

        // Add worldInstanceId to the entity (empty string if no association exists)
        newestEntity.worldInstanceId = worldInstanceId || '';

        // If no version was requested, return the newest entity
        if (!meta.hasVersion) {
          return newestEntity;
        }

        // Get the versioned entity if it was requested
        const [versionedError, versionedResult] = versionedEntities[versionedEntityIndex++];

        if (versionedError || !versionedResult) {
          // Version not found in cache, return full newest entity
          return newestEntity;
        }

        const versionedEntity = JSON.parse(versionedResult);

        // Compute and return the diff
        const diff = this.computeEntityDiff(versionedEntity, newestEntity);
        diff.worldInstanceId = worldInstanceId || '';
        return diff;
      });

    } catch (error) {
      console.error('Batch RedisJSON load failed:', error);
      return requests.map(() => null);
    }
  }

  /**
   * Get a batch of pending updates (dirty entities) for persistence
   * @param {number} batchSize - Maximum number of entities to retrieve
   * @returns {Promise<Array>} - Array of entity keys that need to be persisted
   */
  async getPendingUpdates(batchSize = 100) {
    try {
      // Use SRANDMEMBER to read entities without removing them
      // They will only be removed after successful persistence
      const dirtyKeys = await this.redis.srandmember(this.DIRTY_SET_KEY, batchSize);

      if (!dirtyKeys || dirtyKeys.length === 0) {
        return [];
      }

      // Ensure dirtyKeys is an array (SRANDMEMBER returns single value or array)
      const keysArray = Array.isArray(dirtyKeys) ? dirtyKeys : [dirtyKeys];

      // Parse the keys and load the full entities
      const requests = keysArray.map(key => {
        const parsed = KeyGenerator.parseDirtyKey(key);
        return {
          environment: parsed.environment,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          worldId: parsed.worldId,
          dirtyKey: key // Keep the original key for later removal
        };
      });

      // Load full entities from ephemeral storage
      const entities = await this.batchLoad(requests);

      // Filter out null entities and format for persistence
      return entities
        .map((entity, index) => {
          if (!entity) return null;

          const request = requests[index];
          return {
            environment: request.environment,
            entityType: request.entityType,
            entityId: request.entityId,
            worldId: request.worldId,
            attributes: entity.attributes || {},
            rankScores: entity.rankScores || {},
            version: entity.version,
            dirtyKey: request.dirtyKey, // Include for later removal
            isCreate: false,
            isDelete: entity.isDeleted || false // Include isDelete flag from entity
          };
        })
        .filter(entity => entity !== null);

    } catch (error) {
      console.error('Failed to get pending updates:', error);
      return [];
    }
  }

  /**
   * Get count of pending updates
   * @returns {Promise<number>} - Number of entities waiting to be persisted
   */
  async getPendingCount() {
    try {
      return await this.redis.scard(this.DIRTY_SET_KEY);
    } catch (error) {
      console.error('Failed to get pending count:', error);
      return 0;
    }
  }

  /**
   * Remove entities from dirty set after successful persistence
   * @param {Array} dirtyKeys - Array of dirty key strings
   * @returns {Promise<void>}
   */
  async removeDirtyKeys(dirtyKeys) {
    if (dirtyKeys.length === 0) return;

    try {
      await this.redis.srem(this.DIRTY_SET_KEY, ...dirtyKeys);
      console.log(`Removed ${dirtyKeys.length} entities from dirty set after successful persistence`);
    } catch (error) {
      console.error('Failed to remove dirty keys:', error);
    }
  }

  /**
   * Flush specific entities from ephemeral storage after successful persistence
   * Uses version checking to prevent race conditions with concurrent updates
   *
   * @param {Array} entityKeys - Array of {entityType, entityId, worldId, dirtyKey, persistedVersion} objects
   * @returns {Promise<void>}
   */
  async flushPersistedEntities(entityKeys) {
    if (entityKeys.length === 0) return;

    try {
      // First, check current versions in ephemeral storage to avoid race conditions
      const versionCheckPipeline = this.redis.pipeline();

      entityKeys.forEach(({ environment, entityType, entityId, worldId }) => {
        const versionKey = KeyGenerator.getVersionKey(environment, entityType, entityId, worldId);
        versionCheckPipeline.get(versionKey);
      });

      const versionResults = await versionCheckPipeline.exec();

      // Build Lua script for atomic conditional deletion
      // Only delete if current version <= persisted version (or entity doesn't exist)
      const luaScript = `
        local key = KEYS[1]
        local versionKey = KEYS[2]
        local persistedVersion = tonumber(ARGV[1])

        local currentVersion = redis.call('GET', versionKey)

        -- If entity doesn't exist or persisted version is newer/equal, delete it
        if not currentVersion or not persistedVersion or tonumber(currentVersion) <= persistedVersion then
          redis.call('JSON.DEL', key)
          redis.call('DEL', versionKey)
          return 1
        else
          -- Entity has been updated since persistence, keep it
          return 0
        end
      `;

      const deletionPipeline = this.redis.pipeline();
      const dirtyKeysToRemove = [];
      const safeToDeleteIndices = [];

      entityKeys.forEach(({ environment, entityType, entityId, worldId, dirtyKey, persistedVersion }, index) => {
        const [, currentVersionStr] = versionResults[index];
        const currentVersion = currentVersionStr ? parseInt(currentVersionStr) : null;
        const persisted = persistedVersion || 0;

        // Check if safe to delete
        if (!currentVersion || !persisted || currentVersion <= persisted) {
          const key = this.getEphemeralKey(environment, entityType, entityId, worldId);
          const versionKey = KeyGenerator.getVersionKey(environment, entityType, entityId, worldId);

          // Use Lua script for atomic conditional deletion
          deletionPipeline.eval(luaScript, 2, key, versionKey, persisted);

          safeToDeleteIndices.push(index);

          // Collect dirty keys for removal
          if (dirtyKey) {
            dirtyKeysToRemove.push(dirtyKey);
          } else {
            dirtyKeysToRemove.push(KeyGenerator.getDirtyKey(environment, entityType, entityId, worldId));
          }
        } else {
          // Entity was updated after persistence, don't delete
          console.log(
            `Skipping flush for ${entityType}:${entityId}:${worldId} - ` +
            `current version (${currentVersion}) > persisted version (${persisted})`
          );
        }

        // Note: We don't delete versioned entities (with :vN suffix)
        // as they may still be useful for diff calculations
        // They will expire naturally based on VERSION_CACHE_TTL
      });

      // Execute conditional deletions
      if (safeToDeleteIndices.length > 0) {
        const deletionResults = await deletionPipeline.exec();

        // Count actual deletions (where Lua script returned 1)
        const actualDeletions = deletionResults.filter(([err, result]) => !err && result === 1).length;

        // Remove from dirty set
        if (dirtyKeysToRemove.length > 0) {
          await this.removeDirtyKeys(dirtyKeysToRemove);
        }

        console.log(
          `Flushed ${actualDeletions}/${entityKeys.length} persisted entities from ephemeral storage ` +
          `(${entityKeys.length - safeToDeleteIndices.length} skipped due to newer versions)`
        );
      } else {
        console.log(`No entities flushed - all ${entityKeys.length} have newer versions in ephemeral storage`);
      }

    } catch (error) {
      console.error('Failed to flush persisted entities:', error);
    }
  }
}
