// src/entities/PersistentEntityManager.js
import { prisma, cacheTTL, config } from '../config.js';
import { InputValidator } from './InputValidator.js';
import { EntityDiffUtil } from './EntityDiffUtil.js';
import { KeyGenerator } from './KeyGenerator.js';
import { metrics } from './MetricsCollector.js';
import { StreamUpdateUtil } from './StreamUpdateUtil.js';

export class PersistentEntityManager {
  constructor(cacheManager, streamManager, ephemeralManager = null) {
    this.cache = cacheManager;
    this.prisma = prisma;
    this.streamManager = streamManager;
    this.ephemeralManager = ephemeralManager;
    this.BATCH_SIZE = config.persistent.batchSize;
  }

  // Generate cache key (worldId always included)
  // If version is provided, include it in the cache key
  getCacheKey(entityType, entityId, worldId, version = null) {
    return KeyGenerator.getCacheKey(entityType, entityId, worldId, version);
  }

  // Compute the difference between two entity versions
  // Returns only the attributes and rankScores that changed
  computeEntityDiff(oldEntity, newEntity) {
    return EntityDiffUtil.computeEntityDiff(oldEntity, newEntity, { includeRankScores: true });
  }

  async batchLoad(requests) {
    if (requests.length === 0) return [];

    // Build cache keys for DB entities
    const cacheKeys = [];
    const requestIndexMap = new Map();

    requests.forEach((request, index) => {
      const { entityType, entityId, worldId, version = 0 } = request;
      const newestCacheKey = this.getCacheKey(entityType, entityId, worldId);
      const versionedCacheKey = version > 0 ? this.getCacheKey(entityType, entityId, worldId, version) : null;

      cacheKeys.push(newestCacheKey);
      if (versionedCacheKey) {
        cacheKeys.push(versionedCacheKey);
      }

      requestIndexMap.set(index, {
        newestCacheKey,
        versionedCacheKey,
        request
      });
    });

    // Get world instance association keys for MGET
    const worldInstanceKeys = requests.map(({ entityType, entityId, worldId }) => {
      const streamId = KeyGenerator.getStreamId(entityType, worldId, entityId);
      return this.streamManager.getWorldInstanceKey(streamId);
    });

    // ALWAYS check ephemeral storage for all requests (cache hits and misses)
    const ephemeralRequests = requests.map(({ entityType, entityId, worldId, version = 0 }) => ({
      entityType,
      entityId,
      worldId,
      version
    }));

    // Batch check cache, world instances, and ephemeral storage in parallel
    const [cacheResults, worldInstanceIds, ephemeralEntities] = await Promise.all([
      this.cache.mget(cacheKeys),
      this.streamManager.redis.mget(worldInstanceKeys),
      this.ephemeralManager
        ? this.ephemeralManager.batchLoad(ephemeralRequests).catch(error => {
            console.warn('Failed to check ephemeral manager:', error);
            return requests.map(() => null);
          })
        : Promise.resolve(requests.map(() => null))
    ]);

    // Store DB entities (from cache or will be loaded)
    const dbEntityMap = new Map();
    const cacheMisses = [];

    requests.forEach((request, index) => {
      const { newestCacheKey, versionedCacheKey } = requestIndexMap.get(index);
      const newestCached = cacheResults.get(newestCacheKey);
      const versionedCached = versionedCacheKey ? cacheResults.get(versionedCacheKey) : null;

      if (newestCached) {
        // Cache hit - store DB entity
        metrics.recordCacheHit(request.entityType);
        dbEntityMap.set(index, { newest: newestCached, versioned: versionedCached });
      } else {
        // Cache miss
        metrics.recordCacheMiss(request.entityType);
        cacheMisses.push({ ...request, index, versionedCached });
      }
    });

    // Batch load cache misses from database
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

          // Record database load metrics
          metrics.recordDatabaseLoad(entityType, dbEntities.length);

          return { misses, dbEntities };
        } catch (error) {
          console.error('Batch entity load failed for group:', groupKey, error);
          return { misses, dbEntities: [] };
        }
      });

      const groupResults = await Promise.all(groupQueryPromises);

      // Process results and cache ONLY DB entities (not merged with ephemeral)
      const allCacheEntries = [];

      groupResults.forEach(({ misses, dbEntities }) => {
        const indexedMisses = new Map();
        misses.forEach(miss => {
          indexedMisses.set(miss.entityId, miss);
        });

        dbEntities.forEach(entity => {
          const matchingMiss = indexedMisses.get(entity.id);

          if (matchingMiss) {
            // Cache ONLY the DB entity (without ephemeral merge)
            const newestCacheKey = this.getCacheKey(entity.entityType, entity.id, entity.worldId);
            allCacheEntries.push([newestCacheKey, entity]);

            // Also cache versioned entity
            const versionedCacheKey = this.getCacheKey(entity.entityType, entity.id, entity.worldId, entity.version);
            allCacheEntries.push([versionedCacheKey, entity]);

            // Store in dbEntityMap
            dbEntityMap.set(matchingMiss.index, {
              newest: entity,
              versioned: matchingMiss.versionedCached
            });

            // Track dependencies
            this.cache.trackDependencies(newestCacheKey, [`${entity.entityType}:${entity.id}`]);
          }
        });
      });

      // Batch update cache with DB entities only
      if (allCacheEntries.length > 0) {
        setImmediate(() => this.cache.mset(allCacheEntries, this.cache.defaultTTL));
      }
    }

    // Merge DB entities with ephemeral updates for ALL requests
    return requests.map((request, index) => {
      const dbEntity = dbEntityMap.get(index);
      const ephemeralEntity = ephemeralEntities[index];
      const worldInstanceId = worldInstanceIds[index];

      // If entity is deleted in ephemeral storage, return null
      if (ephemeralEntity && ephemeralEntity.isDeleted) {
        return InputValidator.NULL_MARKER;
      }

      // If no DB entity, return ephemeral entity (or null if no ephemeral either)
      if (!dbEntity || !dbEntity.newest) {
        if (ephemeralEntity && ephemeralEntity.attributes) {
          // Return the ephemeral entity with worldInstanceId
          return {
            ...ephemeralEntity,
            worldInstanceId: worldInstanceId || ''
          };
        }
        return InputValidator.NULL_MARKER;
      }

      let finalEntity = dbEntity.newest;

      // Merge with ephemeral updates if present
      if (ephemeralEntity && ephemeralEntity.attributes) {
        finalEntity = {
          ...dbEntity.newest,
          attributes: {
            ...(dbEntity.newest.attributes || {}),
            ...(ephemeralEntity.attributes || {})
          },
          rankScores: {
            ...(dbEntity.newest.rankScores || {}),
            ...(ephemeralEntity.rankScores || {})
          },
          version: ephemeralEntity.version || dbEntity.newest.version
        };
      }

      // Add worldInstanceId
      finalEntity.worldInstanceId = worldInstanceId || '';

      // Handle version diff if requested
      if (request.version > 0 && dbEntity.versioned) {
        const diff = this.computeEntityDiff(dbEntity.versioned, finalEntity);
        diff.worldInstanceId = worldInstanceId || '';
        return diff;
      }

      return finalEntity;
    });
  }

  async performBatchUpsert(mergedUpdates) {
    const updateEntries = Array.from(mergedUpdates.entries());
    const streamUpdates = []; // Collect stream updates
    const resultMap = new Map(); // Map to store results by entity key

    for (let i = 0; i < updateEntries.length; i += this.BATCH_SIZE) {
      const batch = updateEntries.slice(i, i + this.BATCH_SIZE);

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
        const streamId = KeyGenerator.getStreamId(entityType, worldId, entityId);
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
          const [entityKey, update] = batch[index];
          if (opResult.success) {
            resultMap.set(entityKey, {
              success: true,
              version: opResult.version
            });
            // Record successful database save
            metrics.recordDatabaseSave(update.entityType, 1);
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

      // Update cache for successful operations without reading first
      // Only need to read if we want to preserve non-updated fields
      const cacheEntries = [];

      batch.forEach(([entityKey, update]) => {
        const { entityType, entityId, worldId } = update;
        const result = resultMap.get(entityKey);

        if (result && result.success) {
          // Build cache key to check if entity might be cached
          const cacheKey = this.getCacheKey(entityType, entityId, worldId);

          // For updates (non-delete), we need to check if entity is in cache
          // If it is, we'll update it; if not, we'll skip caching
          // This defers the read to a batched check after all updates
          cacheEntries.push({
            entityKey,
            entityType,
            entityId,
            worldId,
            update,
            result,
            cacheKey
          });
        }
      });

      // Now batch read only the cache keys we need to update
      if (cacheEntries.length > 0) {
        const keysToCheck = cacheEntries.map(e => e.cacheKey);
        const cachedEntities = await this.cache.mget(keysToCheck);
        const finalCacheUpdates = [];

        cacheEntries.forEach((entry, index) => {
          const { entityType, entityId, worldId, update, result } = entry;
          const cached = cachedEntities.get(keysToCheck[index]);

          if (cached) {
            // Entity is in cache, update it
            const updatedEntity = { ...cached };

            // Merge attributes
            if (update.attributes) {
              updatedEntity.attributes = {
                ...(updatedEntity.attributes || {}),
                ...update.attributes
              };
            }

            // Merge rankScores
            if (update.rankScores) {
              updatedEntity.rankScores = {
                ...(updatedEntity.rankScores || {}),
                ...update.rankScores
              };
            }

            // Update version from database result
            updatedEntity.version = result.version;

            // Update worldId
            updatedEntity.worldId = worldId;

            // Cache the updated entity (both newest and versioned)
            const newestCacheKey = this.getCacheKey(entityType, entityId, worldId);
            const versionedCacheKey = this.getCacheKey(entityType, entityId, worldId, result.version);

            finalCacheUpdates.push([newestCacheKey, updatedEntity]);
            finalCacheUpdates.push([versionedCacheKey, updatedEntity]);

            // Track dependencies
            this.cache.trackDependencies(newestCacheKey, [`${entityType}:${entityId}`]);
          }
          // If not in cache, skip caching (entity will be loaded from DB if needed)
        });

        if (finalCacheUpdates.length > 0) {
          setImmediate(() => this.cache.mset(finalCacheUpdates, this.cache.defaultTTL));
        }
      }
    }

    // Batch add to streams (fire-and-forget for performance)
    StreamUpdateUtil.scheduleStreamUpdates(this.streamManager, streamUpdates);

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
