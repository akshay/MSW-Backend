// src/entities/PersistentEntityManager.js
import { prisma } from '../config.js';

export class PersistentEntityManager {
  constructor(cacheManager, streamManager) {
    this.cache = cacheManager;
    this.prisma = prisma;
    this.streamManager = streamManager;
  }

  // Generate cache key (worldId always included)
  getCacheKey(entityType, entityId, worldId) {
    return `entity:${entityType}:${worldId}:${entityId}`;
  }

  async batchLoad(requests) {
    if (requests.length === 0) return [];

    // Group requests by (entityType, worldId) for efficient querying
    const requestGroups = new Map();
    const cacheKeys = [];
    const requestIndexMap = new Map();

    requests.forEach((request, index) => {
      const { entityType, entityId, worldId } = request;
      const cacheKey = this.getCacheKey(entityType, entityId, worldId);
      const groupKey = `${entityType}:${worldId}`;
      
      cacheKeys.push(cacheKey);
      requestIndexMap.set(index, { cacheKey, request });
      
      if (!requestGroups.has(groupKey)) {
        requestGroups.set(groupKey, []);
      }
      requestGroups.get(groupKey).push({ ...request, index });
    });

    // Batch check cache for all entities
    const cacheResults = await this.cache.mget(cacheKeys);
    const resultMap = new Map();
    const cacheMisses = [];

    requests.forEach((request, index) => {
      const { cacheKey } = requestIndexMap.get(index);
      const cached = cacheResults.get(cacheKey);
      
      if (cached) {
        resultMap.set(index, cached);
      } else {
        cacheMisses.push({ ...request, index });
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
              worldId 
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
            const cacheKey = this.getCacheKey(entity.entityType, entity.id, entity.worldId);
            allCacheEntries.push([cacheKey, entity]);
            resultMap.set(matchingMiss.index, entity);
            
            // Track dependencies
            this.cache.trackDependencies(cacheKey, [`${entity.entityType}:${entity.id}`]);
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
    
    updates.forEach(({ entityType, entityId, worldId, attributes, rankScores }) => {
      const key = `${entityType}:${entityId}:${worldId}`;
      const existing = mergedUpdates.get(key) || { 
        entityType, 
        entityId, 
        worldId, 
        attributes: {}, 
        rankScores: {} 
      };
      
      mergedUpdates.set(key, {
        ...existing,
        attributes: { ...existing.attributes, ...attributes },
        rankScores: { ...existing.rankScores, ...(rankScores || {}) }
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
      
      // Prepare batch data for the function
      const batchData = batch.map(({ entityType, entityId, worldId, attributes, rankScores }) => {
        const entityData = {
          entity_type: entityType,
          id: entityId,
          world_id: worldId,
          attributes: attributes
        };

        // Add rank scores if present
        if (rankScores && Object.keys(rankScores).length > 0) {
          entityData.rank_scores = rankScores;
        }

        // Prepare stream update
        const streamId = `entity:${entityType}:${worldId}:${entityId}`;
        streamUpdates.push({
          streamId,
          data: { ...attributes, ...rankScores }
        });

        return entityData;
      });

      // Execute batch upsert using the database function
      await this.prisma.$queryRaw`
        SELECT batch_upsert_entities_partial(${JSON.stringify(batchData)}::JSONB)
      `;

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

    const cacheKey = `rankings:${entityType}:${worldId}:${rankKey}:${sortOrder}:${limit}`;
    
    // Try cache first
    let rankings = await this.cache.get(cacheKey);
    if (rankings) {
      return rankings;
    }

    // Query database with prepared statement for better performance
    try {
      const entities = await this.prisma.$queryRaw`
        SELECT * FROM get_ranked_entities(
          ${entityType}::TEXT,
          ${worldId}::INT,
          ${rankKey}::TEXT,
          ${sortOrder}::TEXT,
          ${limit}::INT
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
    const cacheKey = `rank:${entityType}:${worldId}:${entityId}:${rankKey}`;
    
    // Try cache first with longer TTL
    let rankInfo = await this.cache.get(cacheKey);
    if (rankInfo) {
      return rankInfo;
    }

    try {
      // Single optimized query to get both entity score and rank
      const result = await this.prisma.$queryRaw`
        WITH entity_score AS (
          SELECT (rank_scores->>${rankKey})::FLOAT as score
          FROM entities
          WHERE entity_type = ${entityType}
            AND id = ${entityId}
            AND world_id = ${worldId}
            AND rank_scores ? ${rankKey}
        ),
        rank_calculation AS (
          SELECT 
            COUNT(*) FILTER (WHERE (e.rank_scores->>${rankKey})::FLOAT > es.score) + 1 as rank,
            COUNT(*) as total_entities
          FROM entities e, entity_score es
          WHERE e.entity_type = ${entityType}
            AND e.world_id = ${worldId}
            AND e.rank_scores ? ${rankKey}
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
        entityId,
        entityType,
        worldId,
        rankKey,
        score: parseFloat(score),
        rank: parseInt(rank),
        totalEntities: parseInt(total_entities)
      };

      // Cache with longer TTL
      await this.cache.set(cacheKey, rankInfo, 600, [`${entityType}:${entityId}`]);

      return rankInfo;

    } catch (error) {
      console.error('Calculate entity rank failed:', error);
      return {
        entityId,
        entityType,
        worldId,
        rankKey,
        score: null,
        rank: null,
        totalEntities: 0,
        error: error.message
      };
    }
  }

  // Optimized name search with better indexing
  async searchByName(entityType, namePattern, worldId = null, limit = 100) {
    const cacheKey = worldId 
      ? `search:${entityType}:${worldId}:${namePattern}:${limit}`
      : `search:${entityType}:all:${namePattern}:${limit}`;
    
    let entities = await this.cache.get(cacheKey);
    if (entities) {
      return entities;
    }

    try {
      const entities = await this.prisma.$queryRaw`
        SELECT * FROM get_entities_by_name(
          ${entityType}::TEXT,
          ${worldId}::INT,
          ${namePattern}::TEXT,
          ${limit}::INT
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
