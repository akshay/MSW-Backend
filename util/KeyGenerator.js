// util/KeyGenerator.js

/**
 * Shared utility for generating consistent cache and ephemeral keys
 */
export class KeyGenerator {
  /**
   * Generate key for persistent cache storage
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @param {number|null} version - Optional version number
   * @returns {string}
   */
  static getCacheKey(entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `entity:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `entity:${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Generate key for ephemeral Redis storage
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @param {number|null} version - Optional version number
   * @returns {string}
   */
  static getEphemeralKey(entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `ephemeral:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `ephemeral:${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Generate version counter key for ephemeral storage
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @returns {string}
   */
  static getVersionKey(entityType, entityId, worldId) {
    return `${this.getEphemeralKey(entityType, entityId, worldId)}:version`;
  }

  /**
   * Generate dirty set member key (used for tracking entities needing persistence)
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @returns {string}
   */
  static getDirtyKey(entityType, entityId, worldId) {
    return `${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Parse a dirty key back into components
   * @param {string} dirtyKey
   * @returns {{entityType: string, worldId: number, entityId: string}}
   */
  static parseDirtyKey(dirtyKey) {
    const [entityType, worldIdStr, entityId] = dirtyKey.split(':');
    return {
      entityType,
      entityId,
      worldId: parseInt(worldIdStr)
    };
  }

  /**
   * Generate stream ID for entity
   * @param {string} entityType
   * @param {number} worldId
   * @param {string} entityId
   * @returns {string}
   */
  static getStreamId(entityType, worldId, entityId) {
    return `entity:${entityType}:${worldId}:${entityId}`;
  }
}
