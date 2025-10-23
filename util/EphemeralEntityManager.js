// src/entities/EphemeralEntityManager.js
import { ephemeralRedis, config } from '../config.js';
import { InputValidator } from './InputValidator.js';

export class EphemeralEntityManager {
  constructor(streamManager) {
    this.redis = ephemeralRedis;
    this.streamManager = streamManager;
    this.checkRedisJSONSupport();
    this.DIRTY_SET_KEY = 'ephemeral:dirty_entities'; // Set to track entities with pending updates
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
  getEphemeralKey(entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `ephemeral:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `ephemeral:${entityType}:${worldId}:${entityId}`;
  }

  // Compute the difference between two entity versions
  // Returns only the attributes that changed
  computeEntityDiff(oldEntity, newEntity) {
    if (!oldEntity) {
      return newEntity;
    }

    const diff = {
      ...newEntity,
      attributes: {}
    };

    // Compare attributes
    const oldAttrs = oldEntity.attributes || {};
    const newAttrs = newEntity.attributes || {};

    for (const [key, value] of Object.entries(newAttrs)) {
      if (JSON.stringify(oldAttrs[key]) !== JSON.stringify(value)) {
        diff.attributes[key] = value;
      }
    }

    // Check for deleted attributes
    for (const key of Object.keys(oldAttrs)) {
      if (!(key in newAttrs)) {
        diff.attributes[key] = InputValidator.NULL_MARKER;
      }
    }

    return diff;
  }

  async batchSavePartial(updates) {
    if (updates.length === 0) return [];

    try {
      const timestamp = Date.now();

      // Check which entities exist (batch operation)
      const keys = updates.map(({ entityType, entityId, worldId }) =>
        this.getEphemeralKey(entityType, entityId, worldId)
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
          const { entityType, entityId, worldId, attributes, isCreate = false, isDelete = false } = update;
          const key = batchKeys[batchIndex];
          const exists = batchExists[batchIndex];
          const versionKey = `${key}:version`;

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

          // Track this entity as dirty for background persistence
          // Skip ephemeral-only entity types that should not be persisted to DB
          if (!this.isEphemeralOnly(entityType)) {
            dirtyKeys.push(`${entityType}:${worldId}:${entityId}`);
          }

          // Handle deletion
          if (isDelete) {
            // Delete the entity and its version counter
            pipeline.call('JSON.DEL', key);
            pipeline.del(versionKey);

            // Add deletion to stream
            streamUpdates.push({
              streamId: key,
              data: { deleted: true }
            });

            return; // Skip further processing for this entity
          }

          // Separate attributes into updates and removals
          const attributesToSet = {};
          const attributesToRemove = [];
          const streamData = {};

          Object.entries(attributes).forEach(([field, value]) => {
            if (InputValidator.isNullMarker(value)) {
              // Mark for removal
              attributesToRemove.push(field);
            } else {
              // Mark for set
              attributesToSet[field] = value;
              streamData[field] = value;
            }
          });

          // Prepare stream update data (excluding NULL_MARKER values)
          streamUpdates.push({
            streamId: key, // Use cache key as streamId
            data: streamData
          });

          if (isCreate) {
            // Create new entity (isCreate=true and entity doesn't exist, validated above)
            const newEntity = {
              id: entityId,
              entityType,
              worldId,
              attributes: attributesToSet,
              lastWrite: timestamp,
              version: 1,
              type: 'ephemeral'
            };

            pipeline.call('JSON.SET', key, '$', JSON.stringify(newEntity));
            // Set initial version counter
            versionKeyIndices.push({ index: pipeline.length, batchIndex });
            pipeline.set(versionKey, '1');
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

            // Update worldId and timestamp
            pipeline.call('JSON.SET', key, '$.worldId', worldId);
            pipeline.call('JSON.SET', key, '$.lastWrite', timestamp);

            // Atomically increment version
            versionKeyIndices.push({ index: pipeline.length, batchIndex });
            pipeline.incr(versionKey);

            // Update version in JSON
            pipeline.call('JSON.SET', key, '$.version', '__VERSION_PLACEHOLDER__');
          }
        });

        // Execute pipeline and get version numbers
        const pipelineResults = await pipeline.exec();

        // Extract version numbers from results and cache versioned entities
        const cachePipeline = this.redis.pipeline();

        versionKeyIndices.forEach(({ index, batchIndex }) => {
          const [error, version] = pipelineResults[index];
          if (!error && version) {
            const versionNum = parseInt(version);
            const update = batch[batchIndex];
            const { entityType, entityId, worldId } = update;
            const key = batchKeys[batchIndex];

            // Update the version in the entity JSON
            cachePipeline.call('JSON.SET', key, '$.version', versionNum);

            // Cache this version of the entity for future diff calculations
            const versionedKey = this.getEphemeralKey(entityType, entityId, worldId, versionNum);
            cachePipeline.call('JSON.COPY', key, versionedKey);

            results[i + batchIndex] = { version: versionNum, success: true };
          } else {
            results[i + batchIndex] = { version: 1, success: true };
          }
        });

        // Execute cache pipeline (fire and forget)
        setImmediate(() => cachePipeline.exec());

        // Mark entities as dirty for background persistence
        if (dirtyKeys.length > 0) {
          setImmediate(() => this.redis.sadd(this.DIRTY_SET_KEY, ...dirtyKeys));
        }
      }

      // Batch add to streams (fire-and-forget for performance)
      setImmediate(async () => {
        try {
          await this.streamManager.batchAddToStreams(streamUpdates);
        } catch (error) {
          console.warn('Stream updates failed for ephemeral entities:', error);
        }
      });

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
        const { entityType, entityId, worldId, version = 0 } = request;
        const newestKey = this.getEphemeralKey(entityType, entityId, worldId);
        const versionedKey = version > 0 ? this.getEphemeralKey(entityType, entityId, worldId, version) : null;

        newestKeys.push(newestKey);
        versionedKeys.push(versionedKey);
        requestMeta.push({
          newestKey,
          versionedKey,
          hasVersion: version > 0
        });
      });

      // Create pipeline for JSON.GET operations for newest entities
      const entityPipeline = this.redis.pipeline();
      newestKeys.forEach(key => {
        entityPipeline.call('JSON.GET', key);
      });

      // Also get versioned entities if requested
      versionedKeys.forEach(key => {
        if (key) {
          entityPipeline.call('JSON.GET', key);
        }
      });

      // Get world instance association keys for MGET
      const worldInstanceKeys = requests.map(({ entityType, entityId, worldId }) => {
        const streamId = `entity:${entityType}:${worldId}:${entityId}`;
        return this.streamManager.getWorldInstanceKey(streamId);
      });

      // Execute entity pipeline and MGET in parallel
      const [pipelineResults, worldInstanceIds] = await Promise.all([
        entityPipeline.exec(),
        this.streamManager.redis.mget(worldInstanceKeys)
      ]);

      // Parse results
      const newestEntities = pipelineResults.slice(0, requests.length);
      let versionedEntityIndex = requests.length;

      return requests.map((request, index) => {
        const [newestError, newestResult] = newestEntities[index];
        const worldInstanceId = worldInstanceIds[index];
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
        const [versionedError, versionedResult] = pipelineResults[versionedEntityIndex++];

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
      // Use SPOP to atomically get and remove entities from the dirty set
      // This prevents processing the same entity multiple times
      const dirtyKeys = await this.redis.spop(this.DIRTY_SET_KEY, batchSize);

      if (!dirtyKeys || dirtyKeys.length === 0) {
        return [];
      }

      // Parse the keys and load the full entities
      const requests = dirtyKeys.map(key => {
        const [entityType, worldIdStr, entityId] = key.split(':');
        return {
          entityType,
          entityId,
          worldId: parseInt(worldIdStr)
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
            entityType: request.entityType,
            entityId: request.entityId,
            worldId: request.worldId,
            attributes: entity.attributes || {},
            rankScores: entity.rankScores || {},
            version: entity.version,
            isCreate: false,
            isDelete: false
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
   * Flush specific entities from ephemeral storage after successful persistence
   * @param {Array} entityKeys - Array of {entityType, entityId, worldId} objects
   * @returns {Promise<void>}
   */
  async flushPersistedEntities(entityKeys) {
    if (entityKeys.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();

      entityKeys.forEach(({ entityType, entityId, worldId }) => {
        const key = this.getEphemeralKey(entityType, entityId, worldId);

        // Remove the main entity
        pipeline.call('JSON.DEL', key);

        // Remove the version counter
        pipeline.del(`${key}:version`);

        // Note: We don't delete versioned entities (with :vN suffix)
        // as they may still be useful for diff calculations
        // They will expire naturally or be cleaned up by LRU
      });

      await pipeline.exec();
      console.log(`Flushed ${entityKeys.length} persisted entities from ephemeral storage`);

    } catch (error) {
      console.error('Failed to flush persisted entities:', error);
    }
  }
}
