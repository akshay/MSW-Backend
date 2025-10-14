// src/streams/StreamManager.js
import { streamRedis, cacheTTL } from '../config.js';

export class StreamManager {
  constructor() {
    this.redis = streamRedis;
    this.worldInstanceTTL = cacheTTL / 10; // 30 seconds
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

      return streamUpdates.map(() => ({ success: true }));
    } catch (error) {
      console.error('Batch stream add to multiple streams failed:', error);
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
      cmd.streamId = `entity:${cmd.entityType}:${cmd.worldId}:${cmd.entityId}`;
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
            'timestamp', Date.now()
          );
        });

        // Set expiration for each stream
        pipeline.expire(`stream:${streamId}`, cacheTTL);
      });

      setImmediate(() => pipeline.exec()); // Fire and forget

      return streamCommands.map(() => ({ success: true }));
    } catch (error) {
      console.error('Batch stream add failed:', error);
      return streamCommands.map(() => ({ 
        success: false, 
        error: error.message 
      }));
    }
  }

  async batchPullMessages(pullCommands) {
    if (pullCommands.length === 0) return [];

    try {
      // Handle world instance associations in parallel
      const worldInstancePromises = pullCommands.map(async (cmd) => {
        cmd.streamId = `entity:${cmd.entityType}:${cmd.worldId}:${cmd.entityId}`;
        const worldInstanceKey = this.getWorldInstanceKey(cmd.streamId);
        const currentAssociation = await this.redis.get(worldInstanceKey);
        
        if (!currentAssociation) {
          // No current association - create new one
          await this.redis.setex(worldInstanceKey, this.worldInstanceTTL, cmd.worldInstanceId);
          return cmd.worldInstanceId;
        } else if (currentAssociation === cmd.worldInstanceId) {
          // Same world instance - refresh TTL
          await this.redis.setex(worldInstanceKey, this.worldInstanceTTL, cmd.worldInstanceId);
          return cmd.worldInstanceId;
        } else {
          // Different world instance - return the currently associated one
          return currentAssociation;
        }
      });

      const associatedWorldInstances = await Promise.all(worldInstancePromises);

      // Pull messages from streams in single pipeline
      const pipeline = this.redis.pipeline();

      pullCommands.forEach(cmd => {
        pipeline.xrange(
          `stream:${cmd.streamId}`,
          cmd.timestamp || '-',
          '+',
          'COUNT', cmd.count || 1000
        );
      });

      const results = await pipeline.exec();

      return pullCommands.map((cmd, index) => {
        const [error, messages] = results[index];
        const associatedWorldInstance = associatedWorldInstances[index];
        
        if (error) {
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
            id,
            data: JSON.parse(fields[1]),
            timestamp: parseInt(fields[3])
          }))
        };
      });
    } catch (error) {
      console.error('Batch stream pull failed:', error);
      return pullCommands.map((cmd) => ({
        success: false,
        error: error.message,
        worldInstanceId: cmd.worldInstanceId,
        data: []
      }));
    }
  }
}
