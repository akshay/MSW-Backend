/**
 * @typedef {Object} ConfigFile
 * @property {string} name File path relative to the config root.
 * @property {string} sha256 SHA256 hash of file content.
 * @property {number} size File size in bytes.
 * @property {string|null} b2FileId Backblaze file ID for this exact file version.
 * @property {string} [b2Path] Backblaze path used for this file version.
 */

/**
 * @typedef {Object} ConfigManifest
 * @property {number} snapshotVersion Monotonic config snapshot version.
 * @property {string} createdAt ISO timestamp when the manifest was created.
 * @property {string} [label] Optional human label (release name, rollback reason).
 * @property {Record<string, ConfigFile>} files File metadata keyed by relative path.
 * @property {string} manifestHash SHA256 hash of the manifest payload.
 * @property {string} [manifestId] Backblaze file ID for the stored manifest document.
 */

export {};
