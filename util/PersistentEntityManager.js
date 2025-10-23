// src/entities/PersistentEntityManager.js
import { prisma, cacheTTL } from '../config.js';
import { InputValidator } from './InputValidator.js';

export class PersistentEntityManager {
  constructor(cacheManager, streamManager) {
    this.cache = cacheManager;
    this.prisma = prisma;
    this.streamManager = streamManager;
  }

  // Generate cache key (worldId always included)
  // If version is provided, include it in the cache key
  getCacheKey(entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `entity:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `entity:${entityType}:${worldId}:${entityId}`;
  }

  // Compute the difference between two entity versions
  // Returns only the attributes and rankScores that changed
  computeEntityDiff(oldEntity, newEntity) {
    if (!oldEntity) {
      return newEntity;
    }

    const diff = {
      ...newEntity,
      attributes: {},
      rankScores: {}
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

    // Compare rankScores
    const oldRanks = oldEntity.rankScores || {};
    const newRanks = newEntity.rankScores || {};

    for (const [key, value] of Object.entries(newRanks)) {
      if (JSON.stringify(oldRanks[key]) !== JSON.stringify(value)) {
        diff.rankScores[key] = value;
      }
    }

    // Check for deleted rank scores
    for (const key of Object.keys(oldRanks)) {
      if (!(key in newRanks)) {
        diff.rankScores[key] = InputValidator.NULL_MARKER;
      }
    }

    return diff;
  }

  async batchLoad(requests) {
    if (requests.length === 0) return [];

    // Group requests by (entityType, worldId) for efficient querying
    const requestGroups = new Map();
    const cacheKeys = [];
    const requestIndexMap = new Map();

    requests.forEach((request, index) => {
      const { entityType, entityId, worldId, version = 0 } = request;
      const newestCacheKey = this.getCacheKey(entityType, entityId, worldId);
      const versionedCacheKey = version > 0 ? this.getCacheKey(entityType, entityId, worldId, version) : null;
      const groupKey = `${entityType}:${worldId}`;

      // Always check the newest version
      cacheKeys.push(newestCacheKey);

      // Also check versioned cache if version is specified
      if (versionedCacheKey) {
        cacheKeys.push(versionedCacheKey);
      }

      requestIndexMap.set(index, {
        newestCacheKey,
        versionedCacheKey,
        request
      });

      if (!requestGroups.has(groupKey)) {
        requestGroups.set(groupKey, []);
      }
      requestGroups.get(groupKey).push({ ...request, index });
    });

    // Get world instance association keys for MGET
    const worldInstanceKeys = requests.map(({ entityType, entityId, worldId }) => {
      const streamId = `entity:${entityType}:${worldId}:${entityId}`;
      return this.streamManager.getWorldInstanceKey(streamId);
    });

    // Batch check cache for all entities (newest + versioned) in parallel with world instance fetch
    const [cacheResults, worldInstanceIds] = await Promise.all([
      this.cache.mget(cacheKeys),
      this.streamManager.redis.mget(worldInstanceKeys)
    ]);

    const resultMap = new Map();
    const cacheMisses = [];

    requests.forEach((request, index) => {
      const { newestCacheKey, versionedCacheKey } = requestIndexMap.get(index);
      const newestCached = cacheResults.get(newestCacheKey);
      const versionedCached = versionedCacheKey ? cacheResults.get(versionedCacheKey) : null;

      if (newestCached) {
        // If we have both versions, compute the diff
        if (versionedCached && request.version > 0) {
          const diff = this.computeEntityDiff(versionedCached, newestCached);
          resultMap.set(index, diff);
        } else {
          resultMap.set(index, newestCached);
        }
      } else {
        cacheMisses.push({ ...request, index, versionedCached });
      }
    });

    // Batch load cache misses grouped by entity type and world
    if (cacheMisses.length > 0) {
      const missGroups = new Map();
      cacheMisses.forEach(miss => {
        const groupKey = `${miss.entityType}:${miss.worldId}`;
        if (!missGroups.has(groupKey)) {
          missGroups.set(groupKey, []);
        }
        missGroups.get(groupKey).push(miss);
      });

      // Query each group in parallel
      const groupQueryPromises = Array.from(missGroups.entries()).map(async ([groupKey, misses]) => {
        const [entityType, worldIdStr] = groupKey.split(':');
        const worldId = parseInt(worldIdStr);
        const entityIds = misses.map(miss => miss.entityId);

        try {
          const dbEntities = await this.prisma.entity.findMany({
            where: {
              entityType,
              id: { in: entityIds },
              worldId,
              isDeleted: false
            }
          });

          return { misses, dbEntities };
        } catch (error) {
          console.error('Batch entity load failed for group:', groupKey, error);
          return { misses, dbEntities: [] };
        }
      });

      const groupResults = await Promise.all(groupQueryPromises);

      // Process all group results and update cache
      const allCacheEntries = [];

      groupResults.forEach(({ misses, dbEntities }) => {
        const indexedMisses = new Map();
        misses.forEach(miss => {
          indexedMisses.set(miss.entityId, miss);
        });

        dbEntities.forEach(entity => {
          const matchingMiss = indexedMisses.get(entity.id);

          if (matchingMiss) {
            // Cache the newest version (without version in key)
            const newestCacheKey = this.getCacheKey(entity.entityType, entity.id, entity.worldId);
            allCacheEntries.push([newestCacheKey, entity]);

            // Also cache the versioned entity (with version in key)
            const versionedCacheKey = this.getCacheKey(entity.entityType, entity.id, entity.worldId, entity.version);
            allCacheEntries.push([versionedCacheKey, entity]);

            // Compute diff if we have a versioned entity from earlier
            if (matchingMiss.versionedCached && matchingMiss.version > 0) {
              const diff = this.computeEntityDiff(matchingMiss.versionedCached, entity);
              resultMap.set(matchingMiss.index, diff);
            } else {
              resultMap.set(matchingMiss.index, entity);
            }

            // Track dependencies
            this.cache.trackDependencies(newestCacheKey, [`${entity.entityType}:${entity.id}`]);
          }
        });
      });

      // Batch update cache
      if (allCacheEntries.length > 0) {
        setImmediate(() => this.cache.mset(allCacheEntries, this.cache.defaultTTL));
      }
    }

    // Return results in original order with worldInstanceId
    return requests.map((_, index) => {
      const entity = resultMap.get(index) || InputValidator.NULL_MARKER;
      const worldInstanceId = worldInstanceIds[index];

      // Add worldInstanceId to the entity (empty string if no association exists)
      if (entity !== InputValidator.NULL_MARKER) {
        entity.worldInstanceId = worldInstanceId || '';
      }

      return entity;
    });
  }

  async batchSavePartial(updates) {
    if (updates.length === 0) return [];

    // Group updates by entity (merge multiple updates for same entity)
    const mergedUpdates = new Map();
    const updateKeyMap = new Map(); // Track which merged update each original update maps to

    updates.forEach(({ entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }, index) => {
      const key = `${entityType}:${entityId}:${worldId}`;
      const existing = mergedUpdates.get(key) || {
        entityType,
        entityId,
        worldId,
        attributes: {},
        rankScores: {},
        isCreate: false,
        isDelete: false
      };

      mergedUpdates.set(key, {
        ...existing,
        attributes: { ...existing.attributes, ...(attributes || {}) },
        rankScores: { ...existing.rankScores, ...(rankScores || {}) },
        // If any update in the batch is a create/delete, mark it as such
        isCreate: existing.isCreate || isCreate || false,
        isDelete: existing.isDelete || isDelete || false
      });

      // Track which updates map to which merged entity
      updateKeyMap.set(index, key);
    });

    // Perform batch upsert and get results with version numbers
    const operationResults = await this.performBatchUpsert(mergedUpdates);

    // Map results back to original update order
    return updates.map((_, index) => {
      const key = updateKeyMap.get(index);
      const result = operationResults.get(key);
      return result || { success: false, error: 'Operation failed' };
    });
  }

  async performBatchUpsert(mergedUpdates) {
    const batchSize = 5000; // Increased batch size for better throughput
    const updateEntries = Array.from(mergedUpdates.entries());
    const streamUpdates = []; // Collect stream updates
    const resultMap = new Map(); // Map to store results by entity key

    for (let i = 0; i < updateEntries.length; i += batchSize) {
      const batch = updateEntries.slice(i, i + batchSize);

      // Prepare batch data for the function with input validation
      const batchData = batch.map(([, { entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }]) => {
        const entityData = {
          entity_type: entityType,
          id: entityId,
          world_id: worldId,
          attributes: attributes || {},
          is_create: isCreate || false,
          is_delete: isDelete || false
        };

        // Add rank scores if present
        if (rankScores && Object.keys(rankScores).length > 0) {
          entityData.rank_scores = rankScores;
        }

        // Prepare stream update
        const streamId = `entity:${entityType}:${worldId}:${entityId}`;
        const streamData = {};

        if (isDelete) {
          streamData.deleted = true;
        } else {
          // For creates/updates, include non-null-marker values
          // Add attributes to stream (excluding NULL_MARKER values)
          if (attributes) {
            for (const [key, value] of Object.entries(attributes)) {
              if (!InputValidator.isNullMarker(value)) {
                streamData[key] = value;
              }
            }
          }

          // Add rank scores to stream (excluding NULL_MARKER values)
          if (rankScores) {
            for (const [key, value] of Object.entries(rankScores)) {
              if (!InputValidator.isNullMarker(value)) {
                streamData[key] = value;
              }
            }
          }
        }

        // Only add to stream updates if there's data to send
        if (Object.keys(streamData).length > 0) {
          streamUpdates.push({
            streamId,
            data: streamData
          });
        }

        return entityData;
      });

      // Validate and sanitize batch data before SQL execution
      // This will process NULL_MARKER and separate keys to remove
      const sanitizedBatchData = InputValidator.sanitizeBatchData(batchData);

      // Execute batch upsert using the database function with sanitized data
      const batchDataJson = JSON.stringify(sanitizedBatchData);
      const result = await this.prisma.$queryRaw`
        SELECT batch_upsert_entities_partial(${batchDataJson}::JSONB) as result
      `;

      // Process results and store them by entity key
      if (result && result[0] && result[0].result) {
        const operationResult = result[0].result;
        const results = operationResult.results || [];

        results.forEach((opResult, index) => {
          const [entityKey] = batch[index];
          if (opResult.success) {
            resultMap.set(entityKey, {
              success: true,
              version: opResult.version
            });
          } else {
            resultMap.set(entityKey, {
              success: false,
              error: opResult.error
            });
          }
        });

        // Log any errors from the batch operation
        const failedOps = results.filter(r => !r.success);
        if (failedOps.length > 0) {
          console.warn('Some batch operations failed:', failedOps);
        }
      }

      // Batch invalidate cache for this batch
      const cacheInvalidations = batch.map(([_, { entityType, entityId }]) => `${entityType}:${entityId}`);
      await this.cache.invalidateEntities(cacheInvalidations);
    }

    // Batch add to streams (fire-and-forget for performance)
    setImmediate(async () => {
      try {
        await this.streamManager.batchAddToStreams(streamUpdates);
      } catch (error) {
        console.warn('Stream updates failed for persistent entities:', error);
      }
    });

    console.log(`Atomic batch upsert completed: ${mergedUpdates.size} entities`);
    return resultMap;
  }

  // Batch get ranked entities with batched cache operations
  async batchGetRankedEntities(requests) {
    if (requests.length === 0) return [];

    // Sanitize and build cache keys for all requests
    const sanitizedRequests = requests.map(({ entityType, worldId, rankKey, sortOrder = 'DESC', limit = 100 }) => {
      const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
      const sanitizedWorldId = InputValidator.sanitizeWorldId(worldId);
      const sanitizedRankKey = InputValidator.sanitizeRankKey(rankKey);
      const sanitizedSortOrder = InputValidator.sanitizeSortOrder(sortOrder);
      const sanitizedLimit = InputValidator.sanitizeLimit(limit);
      const cacheKey = `rankings:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedRankKey}:${sanitizedSortOrder}:${sanitizedLimit}`;

      return {
        entityType: sanitizedEntityType,
        worldId: sanitizedWorldId,
        rankKey: sanitizedRankKey,
        sortOrder: sanitizedSortOrder,
        limit: sanitizedLimit,
        cacheKey
      };
    });

    // Batch cache get
    const cacheKeys = sanitizedRequests.map(req => req.cacheKey);
    const cacheResults = await this.cache.mget(cacheKeys);

    // Identify cache misses
    const cacheMisses = [];
    const results = new Array(requests.length);

    sanitizedRequests.forEach((req, index) => {
      const cached = cacheResults.get(req.cacheKey);
      if (cached) {
        results[index] = cached;
      } else {
        cacheMisses.push({ ...req, index });
      }
    });

    // Process cache misses
    if (cacheMisses.length > 0) {
      const dbResults = await Promise.all(
        cacheMisses.map(async (miss) => {
          try {
            const entities = await this.prisma.$queryRaw`
              SELECT * FROM get_ranked_entities(
                ${miss.entityType}::TEXT,
                ${miss.worldId}::INT,
                ${miss.rankKey}::TEXT,
                ${miss.sortOrder}::TEXT,
                ${miss.limit}::INT
              )
            `;

            return { index: miss.index, entities: entities || [] };
          } catch (error) {
            console.error('Ranked entities query failed:', error);
            return { index: miss.index, entities: [] };
          }
        })
      );

      // Batch cache set for all DB results
      const cacheEntries = [];
      dbResults.forEach(({ index, entities }) => {
        results[index] = entities;
        const req = sanitizedRequests[index];

        if (entities && entities.length > 0) {
          const entityIds = entities.map(entity => `${entity.entity_type}:${entity.id}`);
          // Store with dependencies for cache invalidation
          cacheEntries.push([req.cacheKey, entities, entityIds]);
        } else {
          cacheEntries.push([req.cacheKey, entities, []]);
        }
      });

      if (cacheEntries.length > 0) {
        // Set with longer TTL for rankings
        await this.cache.mset(cacheEntries.map(([key, val]) => [key, val]), cacheTTL * 3);
      }
    }

    return results;
  }

  // Batch calculate entity ranks with batched cache operations
  async batchCalculateEntityRank(requests) {
    if (requests.length === 0) return [];

    // Sanitize and build cache keys for all requests
    const sanitizedRequests = requests.map(({ entityType, worldId, entityId, rankKey }) => {
      const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
      const sanitizedWorldId = InputValidator.sanitizeWorldId(worldId);
      const sanitizedEntityId = InputValidator.sanitizeEntityId(entityId);
      const sanitizedRankKey = InputValidator.sanitizeRankKey(rankKey);
      const cacheKey = `rank:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedEntityId}:${sanitizedRankKey}`;

      return {
        entityType: sanitizedEntityType,
        worldId: sanitizedWorldId,
        entityId: sanitizedEntityId,
        rankKey: sanitizedRankKey,
        cacheKey
      };
    });

    // Batch cache get
    const cacheKeys = sanitizedRequests.map(req => req.cacheKey);
    const cacheResults = await this.cache.mget(cacheKeys);

    // Identify cache misses
    const cacheMisses = [];
    const results = new Array(requests.length);

    sanitizedRequests.forEach((req, index) => {
      const cached = cacheResults.get(req.cacheKey);
      if (cached) {
        results[index] = cached;
      } else {
        cacheMisses.push({ ...req, index });
      }
    });

    // Process cache misses
    if (cacheMisses.length > 0) {
      const dbResults = await Promise.all(
        cacheMisses.map(async (miss) => {
          try {
            const result = await this.prisma.$queryRaw`
              WITH entity_score AS (
                SELECT (rank_scores->>${miss.rankKey})::FLOAT as score
                FROM entities
                WHERE entity_type = ${miss.entityType}
                  AND id = ${miss.entityId}
                  AND world_id = ${miss.worldId}
                  AND is_deleted = false
                  AND rank_scores ? ${miss.rankKey}
              ),
              rank_calculation AS (
                SELECT
                  COUNT(*) FILTER (WHERE (e.rank_scores->>${miss.rankKey})::FLOAT > es.score) + 1 as rank,
                  COUNT(*) as total_entities
                FROM entities e, entity_score es
                WHERE e.entity_type = ${miss.entityType}
                  AND e.world_id = ${miss.worldId}
                  AND e.is_deleted = false
                  AND e.rank_scores ? ${miss.rankKey}
              )
              SELECT
                es.score,
                rc.rank,
                rc.total_entities
              FROM entity_score es, rank_calculation rc
            `;

            if (!result || result.length === 0) {
              return {
                index: miss.index,
                rankInfo: {
                  entityId: miss.entityId,
                  entityType: miss.entityType,
                  worldId: miss.worldId,
                  rankKey: miss.rankKey,
                  score: null,
                  rank: null,
                  totalEntities: 0
                }
              };
            }

            const { score, rank, total_entities } = result[0];
            const rankInfo = {
              entityId: miss.entityId,
              entityType: miss.entityType,
              worldId: miss.worldId,
              rankKey: miss.rankKey,
              score: parseFloat(score),
              rank: parseInt(rank),
              totalEntities: parseInt(total_entities)
            };

            return { index: miss.index, rankInfo };
          } catch (error) {
            console.error('Calculate entity rank failed:', error);
            return {
              index: miss.index,
              rankInfo: {
                entityId: miss.entityId,
                entityType: miss.entityType,
                worldId: miss.worldId,
                rankKey: miss.rankKey,
                score: null,
                rank: null,
                totalEntities: 0,
                error: error.message
              }
            };
          }
        })
      );

      // Batch cache set for all DB results
      const cacheEntries = [];
      dbResults.forEach(({ index, rankInfo }) => {
        results[index] = rankInfo;
        const req = sanitizedRequests[index];
        cacheEntries.push([req.cacheKey, rankInfo]);
      });

      if (cacheEntries.length > 0) {
        await this.cache.mset(cacheEntries, cacheTTL * 3);
      }
    }

    return results;
  }

  // Batch search by name with batched cache operations
  async batchSearchByName(requests) {
    if (requests.length === 0) return [];

    // Sanitize and build cache keys for all requests
    const sanitizedRequests = requests.map(({ entityType, namePattern, worldId = null, limit = 100 }) => {
      const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
      const sanitizedNamePattern = InputValidator.sanitizeNamePattern(namePattern);
      const sanitizedWorldId = worldId !== null ? InputValidator.sanitizeWorldId(worldId) : null;
      const sanitizedLimit = InputValidator.sanitizeLimit(limit);

      const cacheKey = sanitizedWorldId
        ? `search:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedNamePattern}:${sanitizedLimit}`
        : `search:${sanitizedEntityType}:all:${sanitizedNamePattern}:${sanitizedLimit}`;

      return {
        entityType: sanitizedEntityType,
        namePattern: sanitizedNamePattern,
        worldId: sanitizedWorldId,
        limit: sanitizedLimit,
        cacheKey
      };
    });

    // Batch cache get
    const cacheKeys = sanitizedRequests.map(req => req.cacheKey);
    const cacheResults = await this.cache.mget(cacheKeys);

    // Identify cache misses
    const cacheMisses = [];
    const results = new Array(requests.length);

    sanitizedRequests.forEach((req, index) => {
      const cached = cacheResults.get(req.cacheKey);
      if (cached) {
        results[index] = cached;
      } else {
        cacheMisses.push({ ...req, index });
      }
    });

    // Process cache misses
    if (cacheMisses.length > 0) {
      const dbResults = await Promise.all(
        cacheMisses.map(async (miss) => {
          try {
            const entities = await this.prisma.$queryRaw`
              SELECT * FROM get_entities_by_name(
                ${miss.entityType}::TEXT,
                ${miss.namePattern}::TEXT,
                ${miss.worldId}::INT,
                ${miss.limit}::INT
              )
            `;

            return { index: miss.index, entities: entities || [] };
          } catch (error) {
            console.error('Name search query failed:', error);
            return { index: miss.index, entities: [] };
          }
        })
      );

      // Batch cache set for all DB results
      const cacheEntries = [];
      dbResults.forEach(({ index, entities }) => {
        results[index] = entities;
        const req = sanitizedRequests[index];

        if (entities && entities.length > 0) {
          const entityIds = entities.map(entity => `${entity.entity_type}:${entity.id}`);
          cacheEntries.push([req.cacheKey, entities, entityIds]);
        } else {
          cacheEntries.push([req.cacheKey, entities, []]);
        }
      });

      if (cacheEntries.length > 0) {
        await this.cache.mset(cacheEntries.map(([key, val]) => [key, val]), cacheTTL);
      }
    }

    return results;
  }
}
