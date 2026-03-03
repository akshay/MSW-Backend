import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { EntityDiffUtil } from '../util/EntityDiffUtil.js';
import { ConfigKeyGenerator } from '../util/ConfigKeyGenerator.js';
import { NULL_MARKER } from '../util/config-diff-types.js';

export class ConfigDiffService {
  constructor({ redis, manifestService, b2, configDir = config.configSync.configDir } = {}) {
    this.redis = redis;
    this.manifestService = manifestService;
    this.b2 = b2;
    this.configDir = configDir;
  }

  computeDiff(oldConfig, newConfig) {
    const previous = this.normalizeToObject(oldConfig);
    const current = this.normalizeToObject(newConfig);
    const diff = {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

    for (const key of keys) {
      const hasOld = Object.prototype.hasOwnProperty.call(previous, key);
      const hasNew = Object.prototype.hasOwnProperty.call(current, key);

      if (!hasNew) {
        diff[key] = NULL_MARKER;
        continue;
      }

      if (!hasOld || !EntityDiffUtil.isEqual(previous[key], current[key])) {
        diff[key] = current[key];
      }
    }

    return diff;
  }

  applyDiff(configObject, diffObject) {
    const base = { ...this.normalizeToObject(configObject) };
    for (const [key, value] of Object.entries(diffObject || {})) {
      if (value === NULL_MARKER) {
        delete base[key];
      } else {
        base[key] = value;
      }
    }
    return base;
  }

  async getDiff(fromVersion, toVersion, environment) {
    const from = Number(fromVersion);
    const to = Number(toVersion);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error('fromVersion and toVersion must be integers');
    }
    if (from === to) {
      return { fromVersion: from, toVersion: to, files: {} };
    }

    const keys = new ConfigKeyGenerator(environment);
    const cacheKey = keys.diff(from, to);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const [oldManifest, newManifest] = await Promise.all([
      this.manifestService.getManifestByVersion(from, environment),
      this.manifestService.getManifestByVersion(to, environment),
    ]);

    if (!newManifest) {
      return null;
    }

    const oldFiles = oldManifest?.files || {};
    const newFiles = newManifest.files || {};
    const fileNames = new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)]);
    const fileDiffs = {};

    for (const fileName of fileNames) {
      const oldMeta = oldFiles[fileName];
      const newMeta = newFiles[fileName];

      if (!newMeta) {
        fileDiffs[fileName] = { __deleted__: NULL_MARKER };
        continue;
      }

      if (!oldMeta) {
        const freshConfig = await this.readConfigFile(fileName, newMeta, environment);
        fileDiffs[fileName] = this.normalizeToObject(freshConfig);
        continue;
      }

      if (oldMeta.sha256 === newMeta.sha256) {
        continue;
      }

      const [oldConfig, newConfig] = await Promise.all([
        this.readConfigFile(fileName, oldMeta, environment),
        this.readConfigFile(fileName, newMeta, environment),
      ]);

      const fileDiff = this.computeDiff(oldConfig, newConfig);
      if (Object.keys(fileDiff).length > 0) {
        fileDiffs[fileName] = fileDiff;
      }
    }

    const diff = {
      fromVersion: from,
      toVersion: to,
      files: fileDiffs,
    };

    await this.redis.setex(cacheKey, ConfigKeyGenerator.DIFF_TTL_SECONDS, JSON.stringify(diff));
    return diff;
  }

  async readConfigFile(fileName, fileMeta, environment) {
    const fromB2 = await this.tryReadFromB2(fileName, fileMeta, environment);
    if (fromB2 !== null) {
      return fromB2;
    }

    const localPath = path.resolve(this.configDir, fileName);
    const content = await fs.readFile(localPath, 'utf8');
    return JSON.parse(content);
  }

  async tryReadFromB2(fileName, fileMeta, environment) {
    if (!this.b2) {
      return null;
    }

    try {
      if (fileMeta?.b2FileId && this.b2.downloadFile) {
        const result = await this.b2.downloadFile(fileMeta.b2FileId, fileName);
        return JSON.parse(result.buffer.toString('utf8'));
      }

      if (fileMeta?.b2Path && this.b2.downloadFileByName && this.b2.getBucketName) {
        const bucketName = this.b2.getBucketName(environment);
        if (!bucketName) {
          return null;
        }
        const result = await this.b2.downloadFileByName(bucketName, fileMeta.b2Path);
        return JSON.parse(result.buffer.toString('utf8'));
      }
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }

    return null;
  }

  isNotFoundError(error) {
    const status = error?.response?.status || error?.status;
    if (status === 404) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('not found') || message.includes('no such file');
  }

  normalizeToObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return { __value__: value };
  }
}
