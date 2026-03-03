import { NULL_MARKER } from './config-diff-types.js';

export class ConfigValidator {
  /**
   * Detect NULL_MARKER collisions in config payloads.
   * @param {unknown} obj
   * @returns {{ valid: boolean, path?: string }}
   */
  static validateNoNullMarker(obj) {
    const path = this.findNullMarkerPath(obj, '');
    if (path) {
      return { valid: false, path };
    }
    return { valid: true };
  }

  static findNullMarkerPath(value, currentPath) {
    if (value === NULL_MARKER) {
      return currentPath || '$';
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const nestedPath = `${currentPath}[${i}]`;
        const found = this.findNullMarkerPath(value[i], nestedPath);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (value && typeof value === 'object') {
      for (const [key, nestedValue] of Object.entries(value)) {
        const nestedPath = currentPath ? `${currentPath}.${key}` : key;
        const found = this.findNullMarkerPath(nestedValue, nestedPath);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }
}
