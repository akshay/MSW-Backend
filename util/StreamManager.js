// src/streams/StreamManager.js
import { streamRedis, cacheTTL, config } from '../config.js';
import { metrics } from './MetricsCollector.js';

export class StreamManager {
  constructor() {
    this.redis = streamRedis;
    this.worldInstanceTTL = config.stream.worldInstanceTTL;
  }

  // Get world instance association key
  getWorldInstanceKey(streamId) {
    return `stream_world_instance:${streamId}`;
  }

  // NEW: Batch add to multiple streams (for save operations)
  async batchAddToStreams(streamUpdates) {
    if (streamUpdates.length === 0) return [];

    try {
      // Group by stream ID and merge messages
      const streamGroups = streamUpdates.reduce((groups, { streamId, data }) => {
        if (!groups[streamId]) {
          groups[streamId] = [];
        }
        groups[streamId].push({
          data,
          timestamp: Date.now()
        });
        return groups;
      }, {});

      // Use single pipeline for all stream operations
      const pipeline = this.redis.pipeline();

      Object.entries(streamGroups).forEach(([streamId, messages]) => {
        messages.forEach(({ data, timestamp }) => {
          pipeline.xadd(
            `stream:${streamId}`,
            '*',
            'data', JSON.stringify(data),
            'timestamp', timestamp
          );
        });

        // Set expiration for each stream
        pipeline.expire(`stream:${streamId}`, cacheTTL);
      });

      setImmediate(() => pipeline.exec()); // Fire and forget

      // Record metrics for each entity type
      const entityTypeCounts = {};
      streamUpdates.forEach(({ streamId }) => {
        const parts = streamId.split(':');
        if (parts.length >= 2) {
          const entityType = parts[1];
          entityTypeCounts[entityType] = (entityTypeCounts[entityType] || 0) + 1;
        }
      });

      Object.entries(entityTypeCounts).forEach(([entityType, count]) => {
        metrics.recordStreamPush(entityType, count);
      });

      return streamUpdates.map(() => ({ success: true }));
    } catch (error) {
      console.error('Batch stream add to multiple streams failed:', error);
      metrics.recordStreamError();
      return streamUpdates.map(() => ({
        success: false,
        error: error.message
      }));
    }
  }

  async batchAddMessages(streamCommands) {
    if (streamCommands.length === 0) return [];

    // Group by stream ID for efficiency
    const streamGroups = streamCommands.reduce((groups, cmd) => {
      cmd.streamId = `${cmd.environment}:entity:${cmd.entityType}:${cmd.worldId}:${cmd.entityId}`;
      (groups[cmd.streamId] = groups[cmd.streamId] || []).push(cmd);
      return groups;
    }, {});

    try {
      const pipeline = this.redis.pipeline();

      Object.entries(streamGroups).forEach(([streamId, commands]) => {
        commands.forEach(cmd => {
          pipeline.xadd(
            `stream:${streamId}`,
            '*',
            'data', JSON.stringify(cmd.message),
            'timestamp', cmd.timestamp || Date.now()
          );
        });

        // Set expiration for each stream
        pipeline.expire(`stream:${streamId}`, cacheTTL);
      });

      setImmediate(() => pipeline.exec()); // Fire and forget

      // Record metrics
      streamCommands.forEach(cmd => {
        metrics.recordStreamPush(cmd.entityType, 1);
      });

      return streamCommands.map(() => ({ success: true }));
    } catch (error) {
      console.error('Batch stream add failed:', error);
      metrics.recordStreamError();
      return streamCommands.map(() => ({
        success: false,
        error: error.message
      }));
    }
  }

  async batchPullMessages(pullCommands) {
    if (pullCommands.length === 0) return [];

    try {
      // Set stream IDs for all commands
      pullCommands.forEach(cmd => {
        cmd.streamId = `${cmd.environment}:entity:${cmd.entityType}:${cmd.worldId}:${cmd.entityId}`;
      });

      // Get world instance association keys for MGET
      const worldInstanceKeys = pullCommands.map(cmd =>
        this.getWorldInstanceKey(cmd.streamId)
      );

      // Create pipeline to pull messages from streams
      const xrangePipeline = this.redis.pipeline();
      pullCommands.forEach(cmd => {
        xrangePipeline.xrange(
          `stream:${cmd.streamId}`,
          cmd.timestamp || '-',
          '+',
          'COUNT', cmd.count || 1000
        );
      });

      // Execute MGET and xrange pipeline in parallel
      const [currentAssociations, xrangeResults] = await Promise.all([
        this.redis.mget(worldInstanceKeys),
        xrangePipeline.exec()
      ]);

      // Create pipeline to set world instance associations
      const setInstancePipeline = this.redis.pipeline();
      const associatedWorldInstances = pullCommands.map((cmd, index) => {
        const currentAssociation = currentAssociations[index];
        const worldInstanceKey = this.getWorldInstanceKey(cmd.streamId);

        if (!currentAssociation) {
          // No current association - create new one
          setInstancePipeline.setex(worldInstanceKey, this.worldInstanceTTL, cmd.worldInstanceId);
          return cmd.worldInstanceId;
        } else if (currentAssociation === cmd.worldInstanceId) {
          // Same world instance - refresh TTL
          setInstancePipeline.setex(worldInstanceKey, this.worldInstanceTTL, cmd.worldInstanceId);
          return cmd.worldInstanceId;
        } else {
          // Different world instance - return the currently associated one
          return currentAssociation;
        }
      });

      // Execute the set pipeline (fire and forget if no sets were added)
      if (setInstancePipeline.length > 0) {
        setImmediate(() => setInstancePipeline.exec());
      }

      const results = xrangeResults;

      // Record metrics
      pullCommands.forEach((cmd, index) => {
        const [error, messages] = results[index];
        if (!error && messages) {
          metrics.recordStreamPull(cmd.entityType, messages.length);
        }
      });

      return pullCommands.map((cmd, index) => {
        const [error, messages] = results[index];
        const associatedWorldInstance = associatedWorldInstances[index];

        if (error) {
          metrics.recordStreamError();
          return {
            success: false,
            error: error.message,
            worldInstanceId: associatedWorldInstance,
            data: []
          };
        }

        return {
          success: true,
          worldInstanceId: associatedWorldInstance,
          data: (messages || []).map(([id, fields]) => ({
            data: JSON.parse(fields[1]),
            timestamp: parseInt(fields[3])
          }))
        };
      });
    } catch (error) {
      console.error('Batch stream pull failed:', error);
      metrics.recordStreamError();
      return pullCommands.map((cmd) => ({
        success: false,
        error: error.message,
        worldInstanceId: cmd.worldInstanceId,
        data: []
      }));
    }
  }
}
