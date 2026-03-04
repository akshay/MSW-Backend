import { config, ephemeralRedis } from '../config.js';
import { DistributedLock } from './DistributedLock.js';
import { InputValidator } from './InputValidator.js';

export class PresenceManager {
  constructor(persistentManager) {
    this.redis = ephemeralRedis;
    this.persistentManager = persistentManager;
    this.lock = new DistributedLock(this.redis);

    this.ttlMs = config.presence.ttlMs;
    this.cleanupIntervalMs = config.presence.cleanupIntervalMs;
    this.cleanupBatchSize = config.presence.cleanupBatchSize;
    this.snapshotCacheMs = config.presence.snapshotCacheMs;
    this.cleanupLockTTLSeconds = config.presence.cleanupLockTTLSeconds;

    this.intervalId = null;
    this.cachedSnapshots = new Map();
  }

  getPresenceZSetKey(environment) {
    return `presence:accounts:last_seen:${environment}`;
  }

  getPresenceStateKey(environment) {
    return `presence:accounts:state:${environment}`;
  }

  getCleanupLockKey(environment) {
    return `presence:cleanup:lock:${environment}`;
  }

  getEmptySnapshot() {
    return {
      snapshotAt: Date.now(),
      ttlMs: this.ttlMs,
      source: 'presence_ttl',
      worldCounts: {},
      channelCounts: {}
    };
  }

  start() {
    if (this.intervalId) {
      return;
    }

    this.runCleanupCycle().catch((error) => {
      console.error('Initial presence cleanup failed:', error);
    });

    this.intervalId = setInterval(() => {
      this.runCleanupCycle().catch((error) => {
        console.error('Presence cleanup cycle failed:', error);
      });
    }, this.cleanupIntervalMs);
  }

  stop() {
    if (!this.intervalId) {
      return;
    }

    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  invalidateSnapshot(environment) {
    this.cachedSnapshots.delete(environment);
  }

  sanitizePresenceEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Presence entry must be an object');
    }

    const rawAccountId = entry.accountId ?? entry.entityId ?? entry.userId;
    if (rawAccountId === undefined || rawAccountId === null) {
      throw new Error('Presence entry requires accountId');
    }

    const accountId = InputValidator.sanitizeEntityId(rawAccountId);
    const worldId = InputValidator.sanitizeWorldId(entry.worldId ?? 0);

    const parsedChannelId = parseInt(entry.channelId ?? 0, 10);
    if (Number.isNaN(parsedChannelId) || parsedChannelId < 0) {
      throw new Error('channelId must be a non-negative integer');
    }
    const channelId = parsedChannelId;

    let characterId = entry.characterId;
    if (characterId === undefined || characterId === null) {
      characterId = '';
    }
    characterId = String(characterId);
    if (characterId.length > 128) {
      throw new Error('characterId must be 128 characters or less');
    }
    if (characterId.length > 0 && !/^[a-zA-Z0-9_-]+$/.test(characterId)) {
      throw new Error('characterId contains invalid characters');
    }

    return {
      accountId,
      worldId,
      channelId,
      characterId
    };
  }

  async recordPresenceBatch(entries, environment, worldInstanceId) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return [];
    }

    const now = Date.now();
    const zsetKey = this.getPresenceZSetKey(environment);
    const stateKey = this.getPresenceStateKey(environment);
    const pipeline = this.redis.pipeline();

    const results = entries.map((entry) => {
      try {
        const normalized = this.sanitizePresenceEntry(entry);
        const payload = {
          accountId: normalized.accountId,
          worldId: normalized.worldId,
          channelId: normalized.channelId,
          characterId: normalized.characterId,
          worldInstanceId: worldInstanceId || '',
          lastSeenMs: now
        };

        pipeline.zadd(zsetKey, now, normalized.accountId);
        pipeline.hset(stateKey, normalized.accountId, JSON.stringify(payload));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    if (pipeline.length > 0) {
      await pipeline.exec();
      this.invalidateSnapshot(environment);
    }

    return results;
  }

  async getPlayerPopulationSnapshot(environment) {
    const now = Date.now();
    const cached = this.cachedSnapshots.get(environment);
    if (cached && now - cached.cachedAt <= this.snapshotCacheMs) {
      return cached.snapshot;
    }

    const cutoffMs = now - this.ttlMs;
    const zsetKey = this.getPresenceZSetKey(environment);
    const stateKey = this.getPresenceStateKey(environment);

    const activeAccountIds = await this.redis.zrangebyscore(zsetKey, cutoffMs, '+inf');
    const worldCounts = {};
    const channelCounts = {};

    if (activeAccountIds.length > 0) {
      const pipeline = this.redis.pipeline();
      activeAccountIds.forEach((accountId) => {
        pipeline.hget(stateKey, accountId);
      });

      const states = await pipeline.exec();
      states.forEach(([error, value]) => {
        if (error || !value) {
          return;
        }

        try {
          const state = JSON.parse(value);
          const worldId = parseInt(state.worldId, 10);
          const channelId = parseInt(state.channelId, 10);
          const characterId = typeof state.characterId === 'string' ? state.characterId : '';

          if (!Number.isInteger(worldId) || worldId <= 0) {
            return;
          }
          if (!Number.isInteger(channelId) || channelId <= 0) {
            return;
          }
          if (!characterId) {
            return;
          }

          const worldKey = String(worldId);
          const channelKey = `${worldId}_${channelId}`;
          worldCounts[worldKey] = (worldCounts[worldKey] || 0) + 1;
          channelCounts[channelKey] = (channelCounts[channelKey] || 0) + 1;
        } catch (_ignored) {
          // Ignore malformed JSON payloads
        }
      });
    }

    const snapshot = {
      snapshotAt: now,
      ttlMs: this.ttlMs,
      source: 'presence_ttl',
      worldCounts,
      channelCounts
    };

    this.cachedSnapshots.set(environment, {
      cachedAt: now,
      snapshot
    });

    return snapshot;
  }

  async runCleanupCycle() {
    for (const environment of config.allowedEnvironments) {
      await this.lock.withLock(
        this.getCleanupLockKey(environment),
        async () => this.cleanupStalePresence(environment),
        this.cleanupLockTTLSeconds
      );
    }
  }

  async cleanupStalePresence(environment) {
    const now = Date.now();
    const cutoffMs = now - this.ttlMs;
    const zsetKey = this.getPresenceZSetKey(environment);
    const stateKey = this.getPresenceStateKey(environment);

    const staleAccountIds = await this.redis.zrangebyscore(
      zsetKey,
      '-inf',
      cutoffMs,
      'LIMIT',
      0,
      this.cleanupBatchSize
    );

    if (!staleAccountIds || staleAccountIds.length === 0) {
      return { processed: 0 };
    }

    const statePipeline = this.redis.pipeline();
    staleAccountIds.forEach((accountId) => {
      statePipeline.hget(stateKey, accountId);
    });
    const staleStates = await statePipeline.exec();

    const updates = new Map();
    const accountIdByEntityKey = new Map();

    staleStates.forEach(([error, value], index) => {
      if (error || !value) {
        return;
      }

      let state;
      try {
        state = JSON.parse(value);
      } catch (_ignored) {
        return;
      }

      const accountId = staleAccountIds[index];
      const worldId = parseInt(state.worldId, 10);
      const channelId = parseInt(state.channelId, 10);
      const characterId = typeof state.characterId === 'string' ? state.characterId : '';

      if ((worldId <= 0 || Number.isNaN(worldId)) && (channelId <= 0 || Number.isNaN(channelId)) && !characterId) {
        return;
      }

      const entityKey = `Account:${accountId}:0`;
      updates.set(entityKey, {
        environment,
        entityType: 'Account',
        entityId: accountId,
        worldId: 0,
        attributes: {
          loginWorld: 0,
          loginChannel: 0,
          loginCharacterId: ''
        },
        isCreate: false,
        isDelete: false
      });
      accountIdByEntityKey.set(entityKey, accountId);
    });

    let failedAccountIds = new Set();

    if (updates.size > 0) {
      const persistResults = await this.persistentManager.performBatchUpsert(updates);
      failedAccountIds = new Set();

      for (const [entityKey, accountId] of accountIdByEntityKey.entries()) {
        const result = persistResults.get(entityKey);
        if (!result) {
          failedAccountIds.add(accountId);
          continue;
        }
        if (!result.success && result.error !== 'ENTITY_NOT_FOUND') {
          failedAccountIds.add(accountId);
        }
      }
    }

    const removableAccountIds = staleAccountIds.filter((accountId) => !failedAccountIds.has(accountId));
    if (removableAccountIds.length > 0) {
      const removePipeline = this.redis.pipeline();
      removePipeline.zrem(zsetKey, ...removableAccountIds);
      removePipeline.hdel(stateKey, ...removableAccountIds);
      await removePipeline.exec();
      this.invalidateSnapshot(environment);
    }

    return {
      processed: removableAccountIds.length,
      failed: failedAccountIds.size
    };
  }
}
