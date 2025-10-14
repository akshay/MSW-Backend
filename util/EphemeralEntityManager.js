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
  getEphemeralKey(entityType, entityId, worldId) {
    return `ephemeral:${entityType}:${worldId}:${entityId}`;
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

        batch.forEach((update, batchIndex) => {
          const { entityType, entityId, worldId, attributes } = update;
          const key = batchKeys[batchIndex];
          const exists = batchExists[batchIndex];

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
              type: 'ephemeral'
            };

            pipeline.call('JSON.SET', key, '$', JSON.stringify(newEntity));
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
          }
        });

        setImmediate(() => pipeline.exec()); // Fire and forget
        results.push(...batch.map(() => ({ success: true })));
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
      const keys = requests.map(({ entityType, entityId, worldId }) => 
        this.getEphemeralKey(entityType, entityId, worldId)
      );

      // Use single pipeline for all JSON.GET operations
      const pipeline = this.redis.pipeline();
      keys.forEach(key => {
        pipeline.call('JSON.GET', key);
      });

      const results = await pipeline.exec();

      return requests.map((request, index) => {
        const [error, result] = results[index];
        
        if (error || !result) {
          return null;
        }

        return JSON.parse(result);
      });

    } catch (error) {
      console.error('Batch RedisJSON load failed:', error);
      return requests.map(() => null);
    }
  }
}
