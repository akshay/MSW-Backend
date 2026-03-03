import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export class ConfigHasher {
  /**
   * Compute SHA256 for a file.
   * @param {string} filePath
   * @returns {string}
   */
  computeFileHash(filePath) {
    const fileBuffer = readFileSync(filePath);
    return createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Compute SHA256 for an object using canonical JSON ordering.
   * @param {unknown} obj
   * @returns {string}
   */
  computeObjectHash(obj) {
    const canonical = this.canonicalize(obj);
    return createHash('sha256').update(canonical).digest('hex');
  }

  canonicalize(value) {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map(item => this.canonicalize(item)).join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${this.canonicalize(value[key])}`);
    return `{${parts.join(',')}}`;
  }
}
