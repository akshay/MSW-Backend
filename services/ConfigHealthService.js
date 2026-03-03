import { config } from '../config.js';
import { ConfigKeyGenerator } from '../util/ConfigKeyGenerator.js';

export class ConfigHealthService {
  constructor({ redis, retentionSeconds = config.configSync.healthRetentionSeconds } = {}) {
    this.redis = redis;
    this.retentionSeconds = retentionSeconds;
  }

  async reportClientVersion(version, environment) {
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
      throw new Error('version must be a non-negative integer');
    }

    const keys = new ConfigKeyGenerator(environment);
    const versionKey = keys.health(parsedVersion);
    const totalsKey = keys.healthTotals();

    const pipeline = this.redis.pipeline();
    pipeline.hincrby(versionKey, 'clients_on_version', 1);
    pipeline.expire(versionKey, this.retentionSeconds);
    pipeline.hincrby(totalsKey, 'clients_total', 1);
    pipeline.expire(totalsKey, this.retentionSeconds);
    await pipeline.exec();
  }

  async reportVersionError(version, errorMessage, environment) {
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
      throw new Error('version must be a non-negative integer');
    }

    const keys = new ConfigKeyGenerator(environment);
    const versionKey = keys.health(parsedVersion);
    const summary = String(errorMessage || 'unknown').slice(0, 256);

    const pipeline = this.redis.pipeline();
    pipeline.hincrby(versionKey, 'version_errors', 1);
    pipeline.hset(versionKey, 'last_error_summary', summary);
    pipeline.expire(versionKey, this.retentionSeconds);
    await pipeline.exec();
  }

  async getVersionHealth(version, environment) {
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
      throw new Error('version must be a non-negative integer');
    }

    const keys = new ConfigKeyGenerator(environment);
    const versionKey = keys.health(parsedVersion);
    const totalsKey = keys.healthTotals();

    const [healthData, totalClientsRaw, currentVersionRaw] = await Promise.all([
      this.redis.hgetall(versionKey),
      this.redis.hget(totalsKey, 'clients_total'),
      this.redis.get(keys.healthCurrentVersion()),
    ]);

    const clientsOnVersion = Number(healthData.clients_on_version || 0);
    const versionErrors = Number(healthData.version_errors || 0);
    const totalClients = Number(totalClientsRaw || 0);
    const adoptionRate = totalClients > 0 ? (clientsOnVersion / totalClients) * 100 : 0;

    return {
      version: parsedVersion,
      currentVersion: currentVersionRaw ? Number(currentVersionRaw) : null,
      clientsOnVersion,
      versionErrors,
      adoptionRate: Number(adoptionRate.toFixed(2)),
      bad: healthData.bad === 'true',
      reason: healthData.bad_reason || null,
      lastErrorSummary: healthData.last_error_summary || null,
    };
  }

  async markVersionBad(version, reason, environment) {
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
      throw new Error('version must be a non-negative integer');
    }

    const keys = new ConfigKeyGenerator(environment);
    const versionKey = keys.health(parsedVersion);
    const pipeline = this.redis.pipeline();
    pipeline.hset(versionKey, 'bad', 'true');
    pipeline.hset(versionKey, 'bad_reason', String(reason || 'manual-mark-bad'));
    pipeline.expire(versionKey, this.retentionSeconds);
    await pipeline.exec();
  }

  async setCurrentVersion(version, environment) {
    const parsedVersion = Number(version);
    if (!Number.isInteger(parsedVersion) || parsedVersion < 0) {
      throw new Error('version must be a non-negative integer');
    }

    const keys = new ConfigKeyGenerator(environment);
    await this.redis.set(keys.healthCurrentVersion(), String(parsedVersion));
  }

  async getVersionDistribution(environment) {
    const matchPattern = `${environment}:config:health:*`;
    let cursor = '0';
    const versionKeys = [];

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const suffix = key.split(':').pop();
        if (/^\d+$/.test(suffix)) {
          versionKeys.push(key);
        }
      }
    } while (cursor !== '0');

    if (versionKeys.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();
    versionKeys.forEach(key => pipeline.hgetall(key));
    const results = await pipeline.exec();

    return versionKeys.map((key, index) => {
      const version = Number(key.split(':').pop());
      const data = results[index]?.[1] || {};
      return {
        version,
        clientsOnVersion: Number(data.clients_on_version || 0),
        versionErrors: Number(data.version_errors || 0),
        bad: data.bad === 'true',
      };
    });
  }
}
