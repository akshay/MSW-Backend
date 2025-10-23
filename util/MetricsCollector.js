// util/MetricsCollector.js
export class MetricsCollector {
  constructor() {
    this.metrics = {
      // Command metrics
      commands: {
        total: 0,
        byType: {},
        successRate: {},
        errors: 0
      },

      // Cache metrics
      cache: {
        hits: 0,
        misses: 0,
        byEntityType: {}
      },

      // Database metrics
      database: {
        loads: 0,
        saves: 0,
        byEntityType: {}
      },

      // World instance metrics
      worldInstances: {
        byId: {},
        total: 0
      },

      // Rate limiting metrics
      rateLimiting: {
        allowed: 0,
        blocked: 0,
        byIp: {}
      },

      // Distributed lock metrics
      locks: {
        acquired: 0,
        failed: 0,
        released: 0,
        contention: 0,
        byLockKey: {}
      },

      // Stream metrics
      streams: {
        messagesPushed: 0,
        messagesPulled: 0,
        byEntityType: {},
        errors: 0
      },

      // Background task metrics
      backgroundTasks: {
        runs: 0,
        successful: 0,
        failed: 0,
        entitiesPersisted: 0,
        lastRunDuration: 0,
        averageRunDuration: 0
      },

      // Performance metrics
      performance: {
        requestDurations: [],
        averageRequestTime: 0,
        p50: 0,
        p95: 0,
        p99: 0
      },

      // System metrics
      system: {
        startTime: Date.now(),
        uptime: 0,
        memoryUsage: {},
        cpuUsage: {}
      },

      // Client-submitted metrics
      clientMetrics: {
        byGroup: {},
        total: 0
      }
    };

    // Ring buffer for request durations (keep last 1000)
    this.maxDurations = 1000;

    // Start periodic system metrics collection
    this.startSystemMetricsCollection();
  }

  // Command metrics
  recordCommand(commandType, success = true, duration = 0, worldInstanceId = null) {
    this.metrics.commands.total++;

    if (!this.metrics.commands.byType[commandType]) {
      this.metrics.commands.byType[commandType] = {
        count: 0,
        success: 0,
        errors: 0,
        totalDuration: 0,
        averageDuration: 0
      };
    }

    const typeMetrics = this.metrics.commands.byType[commandType];
    typeMetrics.count++;
    typeMetrics.totalDuration += duration;
    typeMetrics.averageDuration = typeMetrics.totalDuration / typeMetrics.count;

    if (success) {
      typeMetrics.success++;
    } else {
      typeMetrics.errors++;
      this.metrics.commands.errors++;
    }

    // Update success rate
    this.metrics.commands.successRate[commandType] =
      (typeMetrics.success / typeMetrics.count) * 100;

    // Track by world instance
    if (worldInstanceId) {
      if (!this.metrics.worldInstances.byId[worldInstanceId]) {
        this.metrics.worldInstances.byId[worldInstanceId] = {
          requests: 0,
          commands: 0
        };
      }
      this.metrics.worldInstances.byId[worldInstanceId].commands++;
    }

    // Record request duration for percentile calculations
    this.recordRequestDuration(duration);
  }

  // Cache metrics
  recordCacheHit(entityType) {
    this.metrics.cache.hits++;
    this.initEntityTypeMetrics('cache', entityType);
    this.metrics.cache.byEntityType[entityType].hits++;
  }

  recordCacheMiss(entityType) {
    this.metrics.cache.misses++;
    this.initEntityTypeMetrics('cache', entityType);
    this.metrics.cache.byEntityType[entityType].misses++;
  }

  getCacheHitRate(entityType = null) {
    if (entityType) {
      const typeMetrics = this.metrics.cache.byEntityType[entityType];
      if (!typeMetrics) return 0;
      const total = typeMetrics.hits + typeMetrics.misses;
      return total > 0 ? (typeMetrics.hits / total) * 100 : 0;
    }

    const total = this.metrics.cache.hits + this.metrics.cache.misses;
    return total > 0 ? (this.metrics.cache.hits / total) * 100 : 0;
  }

  // Database metrics
  recordDatabaseLoad(entityType, count = 1) {
    this.metrics.database.loads += count;
    this.initEntityTypeMetrics('database', entityType);
    this.metrics.database.byEntityType[entityType].loads += count;
  }

  recordDatabaseSave(entityType, count = 1) {
    this.metrics.database.saves += count;
    this.initEntityTypeMetrics('database', entityType);
    this.metrics.database.byEntityType[entityType].saves += count;
  }

  // World instance metrics
  recordWorldInstanceRequest(worldInstanceId) {
    this.metrics.worldInstances.total++;
    if (!this.metrics.worldInstances.byId[worldInstanceId]) {
      this.metrics.worldInstances.byId[worldInstanceId] = {
        requests: 0,
        commands: 0
      };
    }
    this.metrics.worldInstances.byId[worldInstanceId].requests++;
  }

  // Rate limiting metrics
  recordRateLimitAllow(ip) {
    this.metrics.rateLimiting.allowed++;
    this.initIpMetrics(ip);
    this.metrics.rateLimiting.byIp[ip].allowed++;
  }

  recordRateLimitBlock(ip) {
    this.metrics.rateLimiting.blocked++;
    this.initIpMetrics(ip);
    this.metrics.rateLimiting.byIp[ip].blocked++;
  }

  // Distributed lock metrics
  recordLockAcquired(lockKey, duration = 0) {
    this.metrics.locks.acquired++;
    this.initLockKeyMetrics(lockKey);
    this.metrics.locks.byLockKey[lockKey].acquired++;
    this.metrics.locks.byLockKey[lockKey].totalHoldTime += duration;
  }

  recordLockFailed(lockKey) {
    this.metrics.locks.failed++;
    this.metrics.locks.contention++;
    this.initLockKeyMetrics(lockKey);
    this.metrics.locks.byLockKey[lockKey].failed++;
  }

  recordLockReleased(lockKey) {
    this.metrics.locks.released++;
    this.initLockKeyMetrics(lockKey);
    this.metrics.locks.byLockKey[lockKey].released++;
  }

  // Stream metrics
  recordStreamPush(entityType, count = 1) {
    this.metrics.streams.messagesPushed += count;
    this.initEntityTypeMetrics('streams', entityType);
    this.metrics.streams.byEntityType[entityType].pushed += count;
  }

  recordStreamPull(entityType, count = 1) {
    this.metrics.streams.messagesPulled += count;
    this.initEntityTypeMetrics('streams', entityType);
    this.metrics.streams.byEntityType[entityType].pulled += count;
  }

  recordStreamError() {
    this.metrics.streams.errors++;
  }

  // Background task metrics
  recordBackgroundTaskRun(success, duration, entitiesPersisted = 0) {
    this.metrics.backgroundTasks.runs++;
    this.metrics.backgroundTasks.lastRunDuration = duration;

    const totalRuns = this.metrics.backgroundTasks.runs;
    const currentAvg = this.metrics.backgroundTasks.averageRunDuration;
    this.metrics.backgroundTasks.averageRunDuration =
      (currentAvg * (totalRuns - 1) + duration) / totalRuns;

    if (success) {
      this.metrics.backgroundTasks.successful++;
      this.metrics.backgroundTasks.entitiesPersisted += entitiesPersisted;
    } else {
      this.metrics.backgroundTasks.failed++;
    }
  }

  // Performance metrics
  recordRequestDuration(duration) {
    const durations = this.metrics.performance.requestDurations;
    durations.push(duration);

    // Keep only last N durations for memory efficiency
    if (durations.length > this.maxDurations) {
      durations.shift();
    }

    // Update average
    const sum = durations.reduce((a, b) => a + b, 0);
    this.metrics.performance.averageRequestTime = sum / durations.length;

    // Update percentiles (only if we have enough samples)
    if (durations.length >= 10) {
      const sorted = [...durations].sort((a, b) => a - b);
      this.metrics.performance.p50 = this.percentile(sorted, 50);
      this.metrics.performance.p95 = this.percentile(sorted, 95);
      this.metrics.performance.p99 = this.percentile(sorted, 99);
    }
  }

  // Client metrics
  recordClientMetric(group, value, tags = {}, worldInstanceId = null) {
    this.metrics.clientMetrics.total++;

    if (!this.metrics.clientMetrics.byGroup[group]) {
      this.metrics.clientMetrics.byGroup[group] = {
        count: 0,
        sum: 0,
        min: value,
        max: value,
        mean: 0,
        median: 0,
        values: [], // Store values for median calculation
        byTags: {},
        byWorldInstance: {}
      };
    }

    const groupMetrics = this.metrics.clientMetrics.byGroup[group];
    groupMetrics.count++;
    groupMetrics.sum += value;
    groupMetrics.min = Math.min(groupMetrics.min, value);
    groupMetrics.max = Math.max(groupMetrics.max, value);
    groupMetrics.mean = groupMetrics.sum / groupMetrics.count;

    // Store value for median calculation (keep last 1000 values for memory efficiency)
    groupMetrics.values.push(value);
    if (groupMetrics.values.length > 1000) {
      groupMetrics.values.shift();
    }

    // Calculate median
    groupMetrics.median = this.calculateMedian(groupMetrics.values);

    // Track by tags if provided
    if (tags && Object.keys(tags).length > 0) {
      const tagKey = JSON.stringify(tags);
      if (!groupMetrics.byTags[tagKey]) {
        groupMetrics.byTags[tagKey] = {
          tags,
          count: 0,
          sum: 0,
          min: value,
          max: value,
          mean: 0,
          median: 0,
          values: []
        };
      }
      const tagMetrics = groupMetrics.byTags[tagKey];
      tagMetrics.count++;
      tagMetrics.sum += value;
      tagMetrics.min = Math.min(tagMetrics.min, value);
      tagMetrics.max = Math.max(tagMetrics.max, value);
      tagMetrics.mean = tagMetrics.sum / tagMetrics.count;

      // Store value for median calculation
      tagMetrics.values.push(value);
      if (tagMetrics.values.length > 1000) {
        tagMetrics.values.shift();
      }
      tagMetrics.median = this.calculateMedian(tagMetrics.values);
    }

    // Track by world instance
    if (worldInstanceId) {
      if (!groupMetrics.byWorldInstance[worldInstanceId]) {
        groupMetrics.byWorldInstance[worldInstanceId] = {
          count: 0,
          sum: 0,
          min: value,
          max: value,
          mean: 0,
          median: 0,
          values: []
        };
      }
      const instanceMetrics = groupMetrics.byWorldInstance[worldInstanceId];
      instanceMetrics.count++;
      instanceMetrics.sum += value;
      instanceMetrics.min = Math.min(instanceMetrics.min, value);
      instanceMetrics.max = Math.max(instanceMetrics.max, value);
      instanceMetrics.mean = instanceMetrics.sum / instanceMetrics.count;

      // Store value for median calculation
      instanceMetrics.values.push(value);
      if (instanceMetrics.values.length > 1000) {
        instanceMetrics.values.shift();
      }
      instanceMetrics.median = this.calculateMedian(instanceMetrics.values);
    }
  }

  // Calculate median from array of values
  calculateMedian(values) {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      // Even number of values - return average of two middle values
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      // Odd number of values - return middle value
      return sorted[mid];
    }
  }

  percentile(sortedArray, percentile) {
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[index];
  }

  // Helper methods for initialization
  initEntityTypeMetrics(category, entityType) {
    if (category === 'cache') {
      if (!this.metrics.cache.byEntityType[entityType]) {
        this.metrics.cache.byEntityType[entityType] = {
          hits: 0,
          misses: 0
        };
      }
    } else if (category === 'database') {
      if (!this.metrics.database.byEntityType[entityType]) {
        this.metrics.database.byEntityType[entityType] = {
          loads: 0,
          saves: 0
        };
      }
    } else if (category === 'streams') {
      if (!this.metrics.streams.byEntityType[entityType]) {
        this.metrics.streams.byEntityType[entityType] = {
          pushed: 0,
          pulled: 0
        };
      }
    }
  }

  initIpMetrics(ip) {
    if (!this.metrics.rateLimiting.byIp[ip]) {
      this.metrics.rateLimiting.byIp[ip] = {
        allowed: 0,
        blocked: 0
      };
    }
  }

  initLockKeyMetrics(lockKey) {
    if (!this.metrics.locks.byLockKey[lockKey]) {
      this.metrics.locks.byLockKey[lockKey] = {
        acquired: 0,
        failed: 0,
        released: 0,
        totalHoldTime: 0
      };
    }
  }

  // System metrics collection
  startSystemMetricsCollection() {
    this.systemMetricsInterval = setInterval(() => {
      this.metrics.system.uptime = Date.now() - this.metrics.system.startTime;
      this.metrics.system.memoryUsage = process.memoryUsage();
      this.metrics.system.cpuUsage = process.cpuUsage();
    }, 5000); // Update every 5 seconds
  }

  stopSystemMetricsCollection() {
    if (this.systemMetricsInterval) {
      clearInterval(this.systemMetricsInterval);
    }
  }

  // Get all metrics
  getAllMetrics() {
    return {
      ...this.metrics,
      cache: {
        ...this.metrics.cache,
        hitRate: this.getCacheHitRate()
      },
      commands: {
        ...this.metrics.commands,
        overallSuccessRate:
          this.metrics.commands.total > 0
            ? ((this.metrics.commands.total - this.metrics.commands.errors) /
                this.metrics.commands.total) *
              100
            : 0
      }
    };
  }

  // Get metrics summary for dashboard
  getSummary() {
    return {
      overview: {
        totalCommands: this.metrics.commands.total,
        totalErrors: this.metrics.commands.errors,
        overallSuccessRate:
          this.metrics.commands.total > 0
            ? ((this.metrics.commands.total - this.metrics.commands.errors) /
                this.metrics.commands.total) *
              100
            : 100,
        cacheHitRate: this.getCacheHitRate(),
        averageResponseTime: Math.round(this.metrics.performance.averageRequestTime),
        uptime: Math.round((Date.now() - this.metrics.system.startTime) / 1000)
      },
      commands: Object.entries(this.metrics.commands.byType).map(([type, data]) => ({
        type,
        count: data.count,
        successRate: (data.success / data.count) * 100,
        avgDuration: Math.round(data.averageDuration)
      })),
      cache: {
        hits: this.metrics.cache.hits,
        misses: this.metrics.cache.misses,
        hitRate: this.getCacheHitRate(),
        byEntityType: Object.entries(this.metrics.cache.byEntityType).map(
          ([type, data]) => ({
            entityType: type,
            hits: data.hits,
            misses: data.misses,
            hitRate: ((data.hits / (data.hits + data.misses)) * 100).toFixed(2)
          })
        )
      },
      database: {
        loads: this.metrics.database.loads,
        saves: this.metrics.database.saves,
        byEntityType: Object.entries(this.metrics.database.byEntityType).map(
          ([type, data]) => ({
            entityType: type,
            loads: data.loads,
            saves: data.saves
          })
        )
      },
      streams: {
        pushed: this.metrics.streams.messagesPushed,
        pulled: this.metrics.streams.messagesPulled,
        errors: this.metrics.streams.errors,
        byEntityType: Object.entries(this.metrics.streams.byEntityType).map(
          ([type, data]) => ({
            entityType: type,
            pushed: data.pushed,
            pulled: data.pulled
          })
        )
      },
      locks: {
        acquired: this.metrics.locks.acquired,
        failed: this.metrics.locks.failed,
        released: this.metrics.locks.released,
        contentionRate:
          this.metrics.locks.acquired + this.metrics.locks.failed > 0
            ? (
                (this.metrics.locks.failed /
                  (this.metrics.locks.acquired + this.metrics.locks.failed)) *
                100
              ).toFixed(2)
            : 0
      },
      rateLimiting: {
        allowed: this.metrics.rateLimiting.allowed,
        blocked: this.metrics.rateLimiting.blocked,
        blockRate:
          this.metrics.rateLimiting.allowed + this.metrics.rateLimiting.blocked > 0
            ? (
                (this.metrics.rateLimiting.blocked /
                  (this.metrics.rateLimiting.allowed +
                    this.metrics.rateLimiting.blocked)) *
                100
              ).toFixed(2)
            : 0
      },
      backgroundTasks: this.metrics.backgroundTasks,
      performance: {
        average: Math.round(this.metrics.performance.averageRequestTime),
        p50: Math.round(this.metrics.performance.p50),
        p95: Math.round(this.metrics.performance.p95),
        p99: Math.round(this.metrics.performance.p99)
      },
      clientMetrics: {
        total: this.metrics.clientMetrics.total,
        groups: Object.entries(this.metrics.clientMetrics.byGroup).map(([group, data]) => ({
          group,
          count: data.count,
          sum: data.sum.toFixed(2),
          min: data.min.toFixed(2),
          max: data.max.toFixed(2),
          mean: data.mean.toFixed(2),
          median: data.median.toFixed(2),
          tagBreakdown: Object.entries(data.byTags).map(([tagKey, tagData]) => ({
            tags: tagData.tags,
            count: tagData.count,
            sum: tagData.sum.toFixed(2),
            min: tagData.min.toFixed(2),
            max: tagData.max.toFixed(2),
            mean: tagData.mean.toFixed(2),
            median: tagData.median.toFixed(2)
          }))
        }))
      }
    };
  }

  // Export metrics in Prometheus format
  toPrometheusFormat() {
    const lines = [];

    // Command metrics
    lines.push('# HELP msw_commands_total Total number of commands processed');
    lines.push('# TYPE msw_commands_total counter');
    lines.push(`msw_commands_total ${this.metrics.commands.total}`);

    Object.entries(this.metrics.commands.byType).forEach(([type, data]) => {
      lines.push(
        `msw_commands_total{type="${type}",result="success"} ${data.success}`
      );
      lines.push(
        `msw_commands_total{type="${type}",result="error"} ${data.errors}`
      );
      lines.push(
        `msw_command_duration_ms{type="${type}"} ${data.averageDuration}`
      );
    });

    // Cache metrics
    lines.push('# HELP msw_cache_hits_total Total cache hits');
    lines.push('# TYPE msw_cache_hits_total counter');
    lines.push(`msw_cache_hits_total ${this.metrics.cache.hits}`);

    lines.push('# HELP msw_cache_misses_total Total cache misses');
    lines.push('# TYPE msw_cache_misses_total counter');
    lines.push(`msw_cache_misses_total ${this.metrics.cache.misses}`);

    // Database metrics
    lines.push('# HELP msw_database_loads_total Total database loads');
    lines.push('# TYPE msw_database_loads_total counter');
    lines.push(`msw_database_loads_total ${this.metrics.database.loads}`);

    lines.push('# HELP msw_database_saves_total Total database saves');
    lines.push('# TYPE msw_database_saves_total counter');
    lines.push(`msw_database_saves_total ${this.metrics.database.saves}`);

    // Stream metrics
    lines.push('# HELP msw_stream_messages_pushed_total Total stream messages pushed');
    lines.push('# TYPE msw_stream_messages_pushed_total counter');
    lines.push(`msw_stream_messages_pushed_total ${this.metrics.streams.messagesPushed}`);

    lines.push('# HELP msw_stream_messages_pulled_total Total stream messages pulled');
    lines.push('# TYPE msw_stream_messages_pulled_total counter');
    lines.push(`msw_stream_messages_pulled_total ${this.metrics.streams.messagesPulled}`);

    // Lock metrics
    lines.push('# HELP msw_locks_acquired_total Total locks acquired');
    lines.push('# TYPE msw_locks_acquired_total counter');
    lines.push(`msw_locks_acquired_total ${this.metrics.locks.acquired}`);

    lines.push('# HELP msw_locks_failed_total Total lock acquisition failures');
    lines.push('# TYPE msw_locks_failed_total counter');
    lines.push(`msw_locks_failed_total ${this.metrics.locks.failed}`);

    // Rate limiting metrics
    lines.push('# HELP msw_rate_limit_allowed_total Total allowed requests');
    lines.push('# TYPE msw_rate_limit_allowed_total counter');
    lines.push(`msw_rate_limit_allowed_total ${this.metrics.rateLimiting.allowed}`);

    lines.push('# HELP msw_rate_limit_blocked_total Total blocked requests');
    lines.push('# TYPE msw_rate_limit_blocked_total counter');
    lines.push(`msw_rate_limit_blocked_total ${this.metrics.rateLimiting.blocked}`);

    // Performance metrics
    lines.push('# HELP msw_request_duration_ms Request duration percentiles');
    lines.push('# TYPE msw_request_duration_ms gauge');
    lines.push(
      `msw_request_duration_ms{quantile="0.5"} ${this.metrics.performance.p50}`
    );
    lines.push(
      `msw_request_duration_ms{quantile="0.95"} ${this.metrics.performance.p95}`
    );
    lines.push(
      `msw_request_duration_ms{quantile="0.99"} ${this.metrics.performance.p99}`
    );

    // Client metrics
    lines.push('# HELP msw_client_metrics_total Total client metrics submitted');
    lines.push('# TYPE msw_client_metrics_total counter');
    lines.push(`msw_client_metrics_total ${this.metrics.clientMetrics.total}`);

    Object.entries(this.metrics.clientMetrics.byGroup).forEach(([group, data]) => {
      const sanitizedGroup = group.replace(/[^a-zA-Z0-9_]/g, '_');

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_count Count of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_count gauge`);
      lines.push(`msw_client_metric_${sanitizedGroup}_count ${data.count}`);

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_mean Mean of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_mean gauge`);
      lines.push(`msw_client_metric_${sanitizedGroup}_mean ${data.mean}`);

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_median Median of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_median gauge`);
      lines.push(`msw_client_metric_${sanitizedGroup}_median ${data.median}`);

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_sum Sum of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_sum counter`);
      lines.push(`msw_client_metric_${sanitizedGroup}_sum ${data.sum}`);

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_min Minimum of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_min gauge`);
      lines.push(`msw_client_metric_${sanitizedGroup}_min ${data.min}`);

      lines.push(`# HELP msw_client_metric_${sanitizedGroup}_max Maximum of ${group} metrics`);
      lines.push(`# TYPE msw_client_metric_${sanitizedGroup}_max gauge`);
      lines.push(`msw_client_metric_${sanitizedGroup}_max ${data.max}`);
    });

    return lines.join('\n');
  }

  // Reset all metrics (useful for testing)
  reset() {
    const startTime = this.metrics.system.startTime;
    this.metrics = {
      commands: { total: 0, byType: {}, successRate: {}, errors: 0 },
      cache: { hits: 0, misses: 0, byEntityType: {} },
      database: { loads: 0, saves: 0, byEntityType: {} },
      worldInstances: { byId: {}, total: 0 },
      rateLimiting: { allowed: 0, blocked: 0, byIp: {} },
      locks: { acquired: 0, failed: 0, released: 0, contention: 0, byLockKey: {} },
      streams: { messagesPushed: 0, messagesPulled: 0, byEntityType: {}, errors: 0 },
      backgroundTasks: {
        runs: 0,
        successful: 0,
        failed: 0,
        entitiesPersisted: 0,
        lastRunDuration: 0,
        averageRunDuration: 0
      },
      performance: {
        requestDurations: [],
        averageRequestTime: 0,
        p50: 0,
        p95: 0,
        p99: 0
      },
      system: {
        startTime,
        uptime: 0,
        memoryUsage: {},
        cpuUsage: {}
      },
      clientMetrics: {
        byGroup: {},
        total: 0
      }
    };
  }
}

// Create singleton instance
export const metrics = new MetricsCollector();
