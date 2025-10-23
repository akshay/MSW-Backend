// util/BatchOperationUtil.js

/**
 * Utility for processing large arrays in batches
 * Provides consistent batch processing patterns across the codebase
 */
export class BatchOperationUtil {
  /**
   * Process items in batches with a given batch size
   *
   * @param {Array} items - Items to process
   * @param {number} batchSize - Size of each batch
   * @param {Function} processFn - Async function to process each batch
   *                                Receives (batch, startIndex) and should return array of results
   * @returns {Promise<Array>} - Flat array of all results
   */
  static async processBatches(items, batchSize, processFn) {
    if (!items || items.length === 0) {
      return [];
    }

    const results = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await processFn(batch, i);

      // Handle both array and non-array results
      if (Array.isArray(batchResults)) {
        results.push(...batchResults);
      } else {
        results.push(batchResults);
      }
    }

    return results;
  }

  /**
   * Split an array into chunks of a given size
   *
   * @param {Array} items - Items to chunk
   * @param {number} chunkSize - Size of each chunk
   * @returns {Array<Array>} - Array of chunks
   */
  static chunk(items, chunkSize) {
    if (!items || items.length === 0) {
      return [];
    }

    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) {
      chunks.push(items.slice(i, i + chunkSize));
    }
    return chunks;
  }
}
