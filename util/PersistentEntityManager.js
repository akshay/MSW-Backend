// src/entities/PersistentEntityManager.js
import { prisma } from '../config.js';
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

    // Batch check cache for all entities (newest + versioned)
    const cacheResults = await this.cache.mget(cacheKeys);
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
        dbEntities.forEach(entity => {
          const matchingMiss = misses.find(miss => miss.entityId === entity.id);

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
        await this.cache.mset(allCacheEntries, 300);
      }
    }

    // Return results in original order
    return requests.map((_, index) => resultMap.get(index) || null);
  }

  async batchSavePartial(updates) {
    if (updates.length === 0) return [];

    // Group updates by entity (merge multiple updates for same entity)
    const mergedUpdates = new Map();

    updates.forEach(({ entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }) => {
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
    });

    // Execute as fire-and-forget for eventual consistency
    setImmediate(async () => {
      try {
        await this.performBatchUpsert(mergedUpdates);
      } catch (error) {
        console.error('Batch save error:', error);
      }
    });

    // Return immediate success responses
    return updates.map(() => ({ success: true }));
  }

  async performBatchUpsert(mergedUpdates) {
    const batchSize = 150; // Increased batch size for better throughput
    const updateEntries = Array.from(mergedUpdates.values());
    const streamUpdates = []; // Collect stream updates

    for (let i = 0; i < updateEntries.length; i += batchSize) {
      const batch = updateEntries.slice(i, i + batchSize);

      // Prepare batch data for the function with input validation
      const batchData = batch.map(({ entityType, entityId, worldId, attributes, rankScores, isCreate, isDelete }) => {
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

      // Log any errors from the batch operation
      if (result && result[0] && result[0].result) {
        const operationResult = result[0].result;
        const failedOps = operationResult.results?.filter(r => !r.success) || [];
        if (failedOps.length > 0) {
          console.warn('Some batch operations failed:', failedOps);
        }
      }

      // Batch invalidate cache for this batch
      const cacheInvalidations = batch.map(({ entityType, entityId }) => `${entityType}:${entityId}`);
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
  }

  // Optimized ranking queries with better caching
  async getRankedEntities(entityType, worldId, rankKey, options = {}) {
    const {
      sortOrder = 'DESC',
      limit = 100
    } = options;

    // Validate all inputs before SQL execution
    const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
    const sanitizedWorldId = InputValidator.sanitizeWorldId(worldId);
    const sanitizedRankKey = InputValidator.sanitizeRankKey(rankKey);
    const sanitizedSortOrder = InputValidator.sanitizeSortOrder(sortOrder);
    const sanitizedLimit = InputValidator.sanitizeLimit(limit);

    const cacheKey = `rankings:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedRankKey}:${sanitizedSortOrder}:${sanitizedLimit}`;

    // Try cache first
    let rankings = await this.cache.get(cacheKey);
    if (rankings) {
      return rankings;
    }

    // Query database with prepared statement for better performance
    try {
      const entities = await this.prisma.$queryRaw`
        SELECT * FROM get_ranked_entities(
          ${sanitizedEntityType}::TEXT,
          ${sanitizedWorldId}::INT,
          ${sanitizedRankKey}::TEXT,
          ${sanitizedSortOrder}::TEXT,
          ${sanitizedLimit}::INT
        )
      `;

      if (entities && entities.length > 0) {
        // Cache with longer TTL and dependencies
        const entityIds = entities.map(entity => `${entity.entity_type}:${entity.id}`);
        await this.cache.set(
          cacheKey,
          entities,
          900, // 15 minutes TTL for rankings
          entityIds
        );
      }

      return entities || [];
    } catch (error) {
      console.error('Ranked entities query failed:', error);
      return [];
    }
  }

  // Optimized entity rank calculation with caching
  async calculateEntityRank(entityType, worldId, entityId, rankKey) {
    // Validate all inputs before SQL execution
    const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
    const sanitizedWorldId = InputValidator.sanitizeWorldId(worldId);
    const sanitizedEntityId = InputValidator.sanitizeEntityId(entityId);
    const sanitizedRankKey = InputValidator.sanitizeRankKey(rankKey);

    const cacheKey = `rank:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedEntityId}:${sanitizedRankKey}`;

    // Try cache first with longer TTL
    let rankInfo = await this.cache.get(cacheKey);
    if (rankInfo) {
      return rankInfo;
    }

    try {
      // Single optimized query to get both entity score and rank
      const result = await this.prisma.$queryRaw`
        WITH entity_score AS (
          SELECT (rank_scores->>${sanitizedRankKey})::FLOAT as score
          FROM entities
          WHERE entity_type = ${sanitizedEntityType}
            AND id = ${sanitizedEntityId}
            AND world_id = ${sanitizedWorldId}
            AND is_deleted = false
            AND rank_scores ? ${sanitizedRankKey}
        ),
        rank_calculation AS (
          SELECT
            COUNT(*) FILTER (WHERE (e.rank_scores->>${sanitizedRankKey})::FLOAT > es.score) + 1 as rank,
            COUNT(*) as total_entities
          FROM entities e, entity_score es
          WHERE e.entity_type = ${sanitizedEntityType}
            AND e.world_id = ${sanitizedWorldId}
            AND e.is_deleted = false
            AND e.rank_scores ? ${sanitizedRankKey}
        )
        SELECT
          es.score,
          rc.rank,
          rc.total_entities
        FROM entity_score es, rank_calculation rc
      `;

      if (!result || result.length === 0) {
        return {
          entityId,
          entityType,
          worldId,
          rankKey,
          score: null,
          rank: null,
          totalEntities: 0
        };
      }

      const { score, rank, total_entities } = result[0];

      const rankInfo = {
        entityId: sanitizedEntityId,
        entityType: sanitizedEntityType,
        worldId: sanitizedWorldId,
        rankKey: sanitizedRankKey,
        score: parseFloat(score),
        rank: parseInt(rank),
        totalEntities: parseInt(total_entities)
      };

      // Cache with longer TTL
      await this.cache.set(cacheKey, rankInfo, 600, [`${sanitizedEntityType}:${sanitizedEntityId}`]);

      return rankInfo;

    } catch (error) {
      console.error('Calculate entity rank failed:', error);
      return {
        entityId: sanitizedEntityId,
        entityType: sanitizedEntityType,
        worldId: sanitizedWorldId,
        rankKey: sanitizedRankKey,
        score: null,
        rank: null,
        totalEntities: 0,
        error: error.message
      };
    }
  }

  // Optimized name search with better indexing
  async searchByName(entityType, namePattern, worldId = null, limit = 100) {
    // Validate all inputs before SQL execution
    const sanitizedEntityType = InputValidator.sanitizeEntityType(entityType);
    const sanitizedNamePattern = InputValidator.sanitizeNamePattern(namePattern);
    const sanitizedWorldId = worldId !== null ? InputValidator.sanitizeWorldId(worldId) : null;
    const sanitizedLimit = InputValidator.sanitizeLimit(limit);

    const cacheKey = sanitizedWorldId
      ? `search:${sanitizedEntityType}:${sanitizedWorldId}:${sanitizedNamePattern}:${sanitizedLimit}`
      : `search:${sanitizedEntityType}:all:${sanitizedNamePattern}:${sanitizedLimit}`;

    let entities = await this.cache.get(cacheKey);
    if (entities) {
      return entities;
    }

    try {
      const entities = await this.prisma.$queryRaw`
        SELECT * FROM get_entities_by_name(
          ${sanitizedEntityType}::TEXT,
          ${sanitizedWorldId}::INT,
          ${sanitizedNamePattern}::TEXT,
          ${sanitizedLimit}::INT
        )
      `;

      if (entities && entities.length > 0) {
        const entityIds = entities.map(entity => `${entity.entity_type}:${entity.id}`);
        await this.cache.set(cacheKey, entities, 300, entityIds);
      }

      return entities || [];
    } catch (error) {
      console.error('Name search query failed:', error);
      return [];
    }
  }
}
