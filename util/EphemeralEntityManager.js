// src/entities/EphemeralEntityManager.js
import { ephemeralRedis } from '../config.js';
import { InputValidator } from './InputValidator.js';

export class EphemeralEntityManager {
  constructor(streamManager) {
    this.redis = ephemeralRedis;
    this.streamManager = streamManager;
    this.checkRedisJSONSupport();
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

        batch.forEach((update, batchIndex) => {
          const { entityType, entityId, worldId, attributes } = update;
          const key = batchKeys[batchIndex];
          const exists = batchExists[batchIndex];
          const versionKey = `${key}:version`;

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

          if (!exists) {
            // Create new entity (ignore NULL_MARKER values - nothing to remove yet)
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
            // Update existing entity attributes atomically

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
}
