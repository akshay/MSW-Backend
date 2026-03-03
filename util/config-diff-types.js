/**
 * Marker used in config diffs to indicate key deletion.
 * Clients should delete a key when this marker is present.
 */
export const NULL_MARKER = '$$__NULL__$$';

/**
 * @typedef {*} ConfigDiffValue
 * Any JSON-serializable value or NULL_MARKER for deletions.
 */

/**
 * @typedef {Record<string, ConfigDiffValue>} ConfigDiffFile
 * Top-level key changes for a single config file.
 */

/**
 * @typedef {Object} ConfigDiff
 * @property {number} fromVersion Source snapshot version.
 * @property {number} toVersion Target snapshot version.
 * @property {Record<string, ConfigDiffFile>} files Per-file top-level key diffs.
 */
