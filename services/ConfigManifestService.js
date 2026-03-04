import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { ConfigHasher } from '../util/ConfigHasher.js';
import { ConfigKeyGenerator } from '../util/ConfigKeyGenerator.js';
import { isSupportedConfigSyncFile } from '../util/ConfigSyncFileRouter.js';

export class ConfigManifestService {
  constructor({ redis, b2, hasher = new ConfigHasher(), configDir = config.configSync.configDir } = {}) {
    this.redis = redis;
    this.b2 = b2;
    this.hasher = hasher;
    this.configDir = configDir;
  }

  validateEnvironment(environment) {
    if (!config.allowedEnvironments.includes(environment)) {
      throw new Error(`Invalid environment: ${environment}`);
    }
  }

  async createManifest(configDirectory = this.configDir, options = {}) {
    const files = {};
    const filePaths = await this.collectConfigFiles(configDirectory);

    for (const absolutePath of filePaths) {
      const relativePath = this.toPosixPath(path.relative(configDirectory, absolutePath));
      const stat = await fs.stat(absolutePath);
      const sha256 = this.hasher.computeFileHash(absolutePath);
      files[relativePath] = {
        name: relativePath,
        sha256,
        size: stat.size,
        b2FileId: null,
      };
    }

    const manifestBase = {
      snapshotVersion: Number.isInteger(options.snapshotVersion) ? options.snapshotVersion : Date.now(),
      createdAt: new Date().toISOString(),
      files,
    };

    if (options.label) {
      manifestBase.label = options.label;
    }

    return {
      ...manifestBase,
      manifestHash: this.hasher.computeObjectHash(manifestBase),
    };
  }

  async publishManifest(manifest, environment, options = {}) {
    this.validateEnvironment(environment);
    if (!this.b2) {
      throw new Error('Backblaze manager is required to publish config');
    }

    const bucketName = this.resolveBucketName(environment);
    const configDirectory = options.configDir || this.configDir;
    const snapshotVersion = await this.getNextVersion(environment, manifest.snapshotVersion);
    const uploadedFiles = {};

    for (const [fileName, fileInfo] of Object.entries(manifest.files || {})) {
      const sourcePath = path.resolve(configDirectory, fileName);
      const b2Path = fileInfo.b2Path || `${config.configSync.filesPrefix}/${fileInfo.sha256}-${path.basename(fileName)}`;
      const uploadResult = await this.b2.uploadFile(sourcePath, b2Path, bucketName);
      uploadedFiles[fileName] = {
        ...fileInfo,
        name: fileName,
        sha256: uploadResult.sha256,
        size: uploadResult.size,
        b2FileId: uploadResult.fileId,
        b2Path,
      };
    }

    const publishPayload = {
      snapshotVersion,
      createdAt: new Date().toISOString(),
      files: uploadedFiles,
    };

    if (manifest.label) {
      publishPayload.label = manifest.label;
    }

    if (manifest.previousVersion !== undefined) {
      publishPayload.previousVersion = manifest.previousVersion;
    }

    return this.publishManifestPointer(publishPayload, environment);
  }

  async publishManifestPointer(manifest, environment) {
    this.validateEnvironment(environment);
    if (!this.b2) {
      throw new Error('Backblaze manager is required to publish config');
    }

    const bucketName = this.resolveBucketName(environment);
    const manifestBase = {
      snapshotVersion: manifest.snapshotVersion,
      createdAt: manifest.createdAt,
      files: manifest.files,
    };

    if (manifest.label) {
      manifestBase.label = manifest.label;
    }
    if (manifest.previousVersion !== undefined) {
      manifestBase.previousVersion = manifest.previousVersion;
    }

    const manifestWithHash = {
      ...manifestBase,
      manifestHash: this.hasher.computeObjectHash(manifestBase),
    };

    const tempVersionPath = path.join(os.tmpdir(), `manifest-${manifestWithHash.snapshotVersion}-${randomUUID()}.json`);
    try {
      await fs.writeFile(tempVersionPath, JSON.stringify(manifestWithHash, null, 2), 'utf8');

      const versionPath = `${config.configSync.manifestsPrefix}/${manifestWithHash.snapshotVersion}.json`;
      const versionUpload = await this.b2.uploadFile(tempVersionPath, versionPath, bucketName);
      const versionedManifest = { ...manifestWithHash, manifestId: versionUpload.fileId };

      await fs.writeFile(tempVersionPath, JSON.stringify(versionedManifest, null, 2), 'utf8');
      const currentUpload = await this.b2.uploadFile(tempVersionPath, config.configSync.currentManifestPath, bucketName);
      const currentManifest = { ...versionedManifest, manifestId: currentUpload.fileId };

      await this.cacheManifest(currentManifest, environment, true);
      await this.cacheManifest(versionedManifest, environment, false);

      return currentManifest;
    } finally {
      await fs.unlink(tempVersionPath).catch(() => {});
    }
  }

  async getCurrentManifest(environment) {
    this.validateEnvironment(environment);
    const keys = new ConfigKeyGenerator(environment);
    const cached = await this.redis.get(keys.currentManifest());
    if (cached) {
      return JSON.parse(cached);
    }

    const remoteManifest = await this.downloadManifestByName(environment, config.configSync.currentManifestPath);
    if (!remoteManifest) {
      return null;
    }

    await this.cacheManifest(remoteManifest, environment, true);
    return remoteManifest;
  }

  async getManifestByVersion(version, environment) {
    this.validateEnvironment(environment);
    const keys = new ConfigKeyGenerator(environment);
    const cacheKey = keys.versionManifest(version);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const remoteManifest = await this.downloadManifestByName(
      environment,
      `${config.configSync.manifestsPrefix}/${version}.json`,
    );
    if (!remoteManifest) {
      return null;
    }

    await this.cacheManifest(remoteManifest, environment, false);
    return remoteManifest;
  }

  async rollbackToVersion(version, environment) {
    this.validateEnvironment(environment);
    const targetVersion = Number(version);
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      throw new Error('targetVersion must be a non-negative integer');
    }

    const [targetManifest, currentManifest] = await Promise.all([
      this.getManifestByVersion(targetVersion, environment),
      this.getCurrentManifest(environment),
    ]);

    if (!targetManifest) {
      throw new Error(`Target version ${targetVersion} not found`);
    }

    const nextVersion = await this.getNextVersion(environment);
    const rollbackManifest = {
      snapshotVersion: nextVersion,
      createdAt: new Date().toISOString(),
      label: `rollback-to-${targetVersion}`,
      previousVersion: currentManifest?.snapshotVersion ?? null,
      files: targetManifest.files,
    };

    return this.publishManifestPointer(rollbackManifest, environment);
  }

  async getNextVersion(environment, requestedVersion = null) {
    const currentManifest = await this.getCurrentManifest(environment);
    const currentVersion = Number(currentManifest?.snapshotVersion || 0);
    if (Number.isInteger(requestedVersion) && requestedVersion > currentVersion) {
      return requestedVersion;
    }
    return currentVersion + 1;
  }

  async cacheManifest(manifest, environment, setAsCurrent) {
    const keys = new ConfigKeyGenerator(environment);
    const serialized = JSON.stringify(manifest);

    if (setAsCurrent) {
      await this.redis.set(keys.currentManifest(), serialized);
    }

    await this.redis.setex(
      keys.versionManifest(manifest.snapshotVersion),
      ConfigKeyGenerator.MANIFEST_TTL_SECONDS,
      serialized,
    );
  }

  async collectConfigFiles(rootDir, baseDir = rootDir) {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.collectConfigFiles(fullPath, baseDir);
        files.push(...nested);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.json')) {
        const relativePath = this.toPosixPath(path.relative(baseDir, fullPath));
        if (isSupportedConfigSyncFile(relativePath)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  async downloadManifestByName(environment, fileName) {
    if (!this.b2) {
      return null;
    }

    const bucketName = this.resolveBucketName(environment);
    if (!bucketName || !this.b2.downloadFileByName) {
      return null;
    }

    try {
      const result = await this.b2.downloadFileByName(bucketName, fileName);
      return JSON.parse(result.buffer.toString('utf8'));
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  isNotFoundError(error) {
    const status = error?.response?.status || error?.status;
    if (status === 404) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('not found') || message.includes('no such file');
  }

  resolveBucketName(environment) {
    if (this.b2?.getBucketName) {
      const value = this.b2.getBucketName(environment);
      if (value) {
        return value;
      }
    }

    return environment === 'staging' ? config.backblaze.stagingBucket : config.backblaze.productionBucket;
  }

  toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
  }
}
