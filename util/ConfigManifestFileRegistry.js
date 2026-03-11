import path from 'path';
import {
  getSupportedConfigSyncFiles,
  normalizeConfigSyncFileName,
} from './ConfigSyncFileRouter.js';

const EXTRA_MANIFEST_FILES = Object.freeze([
  'Augment.nx.json',
  'Mob.nx.json',
  'String.nx.json',
]);
const EXTRA_MANIFEST_FILE_SET = new Set(
  EXTRA_MANIFEST_FILES.map((fileName) => fileName.toLowerCase()),
);

export function isTrackedConfigManifestFile(rawFileName) {
  const normalized = normalizeConfigSyncFileName(rawFileName);
  if (!normalized) {
    return false;
  }

  const supportedSyncFiles = getSupportedConfigSyncFiles();
  if (supportedSyncFiles.includes(normalized)) {
    return true;
  }

  const baseName = path.posix.basename(normalized);
  return EXTRA_MANIFEST_FILE_SET.has(baseName.toLowerCase());
}

export function getTrackedConfigManifestFiles() {
  const supported = new Set(getSupportedConfigSyncFiles());
  for (const fileName of EXTRA_MANIFEST_FILES) {
    supported.add(fileName);
  }
  return [...supported].sort();
}
