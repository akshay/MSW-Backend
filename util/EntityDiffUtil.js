// util/EntityDiffUtil.js
import { InputValidator } from './InputValidator.js';

/**
 * Utility for computing differences between entity versions
 * Shared between EphemeralEntityManager and PersistentEntityManager
 */
export class EntityDiffUtil {
  /**
   * Fast deep equality check for primitive values and simple objects
   * Faster than JSON.stringify for most cases
   */
  static isEqual(a, b) {
    // Fast path for primitives and same reference
    if (a === b) return true;

    // Handle null/undefined
    if (a == null || b == null) return a === b;

    // Different types
    const typeA = typeof a;
    const typeB = typeof b;
    if (typeA !== typeB) return false;

    // Primitives that aren't equal
    if (typeA !== 'object') return false;

    // Arrays
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.isEqual(a[i], b[i])) return false;
      }
      return true;
    }

    // Dates
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    // Objects
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    // Use Set for O(1) lookup instead of O(n) includes
    const keysBSet = new Set(keysB);

    for (const key of keysA) {
      if (!keysBSet.has(key) || !this.isEqual(a[key], b[key])) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compute the difference between two entity versions
   * Returns only the attributes and rankScores that changed
   *
   * @param {Object} oldEntity - Previous version of the entity
   * @param {Object} newEntity - Current version of the entity
   * @param {Object} options - Options for diff computation
   * @param {boolean} options.includeRankScores - Whether to include rankScores in diff (default: true)
   * @returns {Object} - Entity diff with only changed fields
   */
  static computeEntityDiff(oldEntity, newEntity, options = {}) {
    const { includeRankScores = true } = options;

    if (!oldEntity) {
      return newEntity;
    }

    const diff = {
      ...newEntity,
      attributes: {}
    };

    if (includeRankScores) {
      diff.rankScores = {};
    }

    // Compare attributes
    const oldAttrs = oldEntity.attributes || {};
    const newAttrs = newEntity.attributes || {};

    for (const [key, value] of Object.entries(newAttrs)) {
      if (!this.isEqual(oldAttrs[key], value)) {
        diff.attributes[key] = value;
      }
    }

    // Check for deleted attributes
    for (const key of Object.keys(oldAttrs)) {
      if (!(key in newAttrs)) {
        diff.attributes[key] = InputValidator.NULL_MARKER;
      }
    }

    // Compare rankScores if requested
    if (includeRankScores) {
      const oldRanks = oldEntity.rankScores || {};
      const newRanks = newEntity.rankScores || {};

      for (const [key, value] of Object.entries(newRanks)) {
        if (!this.isEqual(oldRanks[key], value)) {
          diff.rankScores[key] = value;
        }
      }

      // Check for deleted rank scores
      for (const key of Object.keys(oldRanks)) {
        if (!(key in newRanks)) {
          diff.rankScores[key] = InputValidator.NULL_MARKER;
        }
      }
    }

    return diff;
  }
}
