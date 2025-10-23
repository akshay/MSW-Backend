// util/StreamUpdateUtil.js

/**
 * Utility for managing stream updates in a fire-and-forget pattern
 * Shared between EphemeralEntityManager and PersistentEntityManager
 */
export class StreamUpdateUtil {
  /**
   * Schedule stream updates asynchronously without blocking the main operation
   * Uses setImmediate to defer the work to the next event loop iteration
   *
   * @param {Object} streamManager - The stream manager instance
   * @param {Array} updates - Array of {streamId, data} objects
   * @returns {void} - Fire-and-forget, no return value
   */
  static scheduleStreamUpdates(streamManager, updates) {
    if (!streamManager || !updates || updates.length === 0) {
      return;
    }

    setImmediate(async () => {
      try {
        await streamManager.batchAddToStreams(updates);
      } catch (error) {
        console.warn('Stream updates failed:', error);
      }
    });
  }
}
