export class ConfigSnapshotReader {
  constructor({ manifestService, b2 }) {
    this.manifestService = manifestService;
    this.b2 = b2;
    this.fileCache = new Map();
  }

  async getCurrentSnapshot(environment, requiredFiles = []) {
    const manifest = await this.manifestService.getCurrentManifest(environment);
    if (!manifest) {
      const error = new Error('No config manifest has been published for this environment');
      error.code = 'manifest_not_found';
      throw error;
    }

    const files = {};
    const missingFiles = [];
    for (const fileName of requiredFiles) {
      const manifestEntry = this.resolveManifestEntry(manifest, fileName);
      if (!manifestEntry) {
        missingFiles.push(fileName);
        continue;
      }
      files[fileName] = await this.readManifestJsonFile(environment, manifest, fileName, manifestEntry);
    }

    return {
      manifest,
      files,
      missingFiles,
    };
  }

  resolveManifestEntry(manifest, targetFileName) {
    const manifestFiles = manifest?.files || {};
    if (manifestFiles[targetFileName]) {
      return {
        fileName: targetFileName,
        meta: manifestFiles[targetFileName],
      };
    }

    const targetLower = String(targetFileName).toLowerCase();
    for (const [fileName, meta] of Object.entries(manifestFiles)) {
      const baseName = fileName.split('/').pop() || fileName;
      if (baseName.toLowerCase() === targetLower) {
        return {
          fileName,
          meta,
        };
      }
    }

    return null;
  }

  async readManifestJsonFile(environment, manifest, targetFileName, manifestEntry) {
    const meta = manifestEntry.meta || {};
    const cacheKey = [
      environment,
      manifest.snapshotVersion,
      manifestEntry.fileName,
      meta.sha256 || meta.b2FileId || meta.b2Path || 'unversioned',
    ].join(':');

    if (this.fileCache.has(cacheKey)) {
      return this.fileCache.get(cacheKey);
    }

    const rawText = await this.downloadManifestFile(environment, manifestEntry);
    const parsed = JSON.parse(rawText);
    this.fileCache.set(cacheKey, parsed);
    return parsed;
  }

  async downloadManifestFile(environment, manifestEntry) {
    if (!this.b2) {
      const error = new Error('Backblaze file manager is not configured');
      error.code = 'snapshot_backend_unavailable';
      throw error;
    }

    const meta = manifestEntry.meta || {};
    if (meta.b2FileId && this.b2.downloadFile) {
      const result = await this.b2.downloadFile(meta.b2FileId, manifestEntry.fileName);
      return result.buffer.toString('utf8');
    }

    const b2Path = meta.b2Path || manifestEntry.fileName;
    if (this.b2.downloadFileByName) {
      const bucketName = this.resolveBucketName(environment);
      const result = await this.b2.downloadFileByName(bucketName, b2Path);
      return result.buffer.toString('utf8');
    }

    const error = new Error(`Unable to download manifest file ${manifestEntry.fileName}`);
    error.code = 'snapshot_download_unavailable';
    throw error;
  }

  resolveBucketName(environment) {
    if (this.b2.getBucketName) {
      const bucketName = this.b2.getBucketName(environment);
      if (bucketName) {
        return bucketName;
      }
    }
    return this.manifestService.resolveBucketName(environment);
  }
}
