// util/KeyGenerator.js

/**
 * Shared utility for generating consistent cache and ephemeral keys
 */
export class KeyGenerator {
  /**
   * Generate key for persistent cache storage
   * @param {string} environment - The environment (staging/production)
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @param {number|null} version - Optional version number
   * @returns {string}
   */
  static getCacheKey(environment, entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `${environment}:entity:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `${environment}:entity:${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Generate key for ephemeral Redis storage
   * @param {string} environment - The environment (staging/production)
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @param {number|null} version - Optional version number
   * @returns {string}
   */
  static getEphemeralKey(environment, entityType, entityId, worldId, version = null) {
    if (version !== null) {
      return `${environment}:ephemeral:${entityType}:${worldId}:${entityId}:v${version}`;
    }
    return `${environment}:ephemeral:${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Generate version counter key for ephemeral storage
   * @param {string} environment - The environment (staging/production)
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @returns {string}
   */
  static getVersionKey(environment, entityType, entityId, worldId) {
    return `${this.getEphemeralKey(environment, entityType, entityId, worldId)}:version`;
  }

  /**
   * Generate dirty set member key (used for tracking entities needing persistence)
   * @param {string} environment - The environment (staging/production)
   * @param {string} entityType
   * @param {string} entityId
   * @param {number} worldId
   * @returns {string}
   */
  static getDirtyKey(environment, entityType, entityId, worldId) {
    return `${environment}:${entityType}:${worldId}:${entityId}`;
  }

  /**
   * Parse a dirty key back into components
   * @param {string} dirtyKey
   * @returns {{environment: string, entityType: string, worldId: number, entityId: string}}
   */
  static parseDirtyKey(dirtyKey) {
    const [environment, entityType, worldIdStr, entityId] = dirtyKey.split(':');
    return {
      environment,
      entityType,
      entityId,
      worldId: parseInt(worldIdStr)
    };
  }

  /**
   * Generate stream ID for entity
   * @param {string} environment - The environment (staging/production)
   * @param {string} entityType
   * @param {number} worldId
   * @param {string} entityId
   * @returns {string}
   */
  static getStreamId(environment, entityType, worldId, entityId) {
    return `${environment}:entity:${entityType}:${worldId}:${entityId}`;
  }
}
