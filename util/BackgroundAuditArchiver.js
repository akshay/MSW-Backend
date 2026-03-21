import { auditRedis, cacheRedis, prisma, config } from '../config.js';
import { DistributedLock } from './DistributedLock.js';
import { metrics } from './MetricsCollector.js';

export class BackgroundAuditArchiver {
  constructor(options = {}) {
    this.redis = options.redis || auditRedis;
    this.cacheRedis = options.cacheRedis || cacheRedis;
    this.prisma = options.prisma || prisma;
    
    this.lock = options.lock || new DistributedLock(this.cacheRedis);
    this.streamKey = config.audit.streamKey;
    this.consumerGroup = 'audit-archiver';
    this.consumerName = `archiver-${process.pid || Date.now()}`;
    
    this.lockKey = 'audit:archive:lock';
    this.lockTTL = config.audit.lockTTL;
    this.batchSize = config.audit.batchSize;
    this.intervalMs = config.audit.archiveIntervalMs;
    
    this.isRunning = false;
    this.intervalId = null;
    this.initialized = false;
    
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      commandsArchived: 0,
      lastRunTime: null,
      lastError: null,
      lastBatchSize: 0
    };
  }

  async initialize() {
    if (this.initialized) return;
    
    try {
      try {
        await this.redis.xgroup(
          'CREATE',
          this.streamKey,
          this.consumerGroup,
          '0',
          'MKSTREAM'
        );
      } catch (error) {
        if (!error.message?.includes('BUSYGROUP')) {
          console.error('[BackgroundAuditArchiver] Failed to create consumer group:', error);
        }
      }
      
      this.initialized = true;
      console.log('[BackgroundAuditArchiver] Initialized successfully');
    } catch (error) {
      console.error('[BackgroundAuditArchiver] Initialization failed:', error);
    }
  }

  start() {
    if (this.isRunning) {
      console.log('[BackgroundAuditArchiver] Already running');
      return;
    }

    console.log(`[BackgroundAuditArchiver] Starting (interval: ${this.intervalMs}ms, batch: ${this.batchSize})`);
    this.isRunning = true;
    
    this.initialize().then(() => {
      this.run();
      this.intervalId = setInterval(() => this.run(), this.intervalMs);
    });
  }

  stop() {
    if (!this.isRunning) {
      console.log('[BackgroundAuditArchiver] Not running');
      return;
    }

    console.log('[BackgroundAuditArchiver] Stopping');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async run() {
    if (!this.isRunning) return;

    this.stats.totalRuns++;
    const startTime = Date.now();

    try {
      const result = await this.lock.withLock(
        this.lockKey,
        () => this.processBatch(),
        this.lockTTL
      );

      if (result === null) {
        return;
      }

      this.stats.successfulRuns++;
      this.stats.lastRunTime = new Date().toISOString();
      this.stats.commandsArchived += result.archived;
      this.stats.lastBatchSize = result.archived;

      const duration = Date.now() - startTime;
      metrics.recordAuditArchive(result.archived, duration);

      if (result.archived > 0) {
        console.log(
          `[BackgroundAuditArchiver] Archived ${result.archived} commands in ${duration}ms`
        );
      }
    } catch (error) {
      this.stats.failedRuns++;
      this.stats.lastError = error.message;
      console.error('[BackgroundAuditArchiver] Run failed:', error);
    }
  }

  async processBatch() {
    await this.initialize();

    const entries = await this.readFromStream();
    
    if (entries.length === 0) {
      return { archived: 0 };
    }

    const archived = await this.archiveToDatabase(entries);
    
    await this.acknowledgeEntries(entries);

    return { archived };
  }

  async readFromStream() {
    try {
      const result = await this.redis.xreadgroup(
        'GROUP', this.consumerGroup, this.consumerName,
        'COUNT', this.batchSize,
        'BLOCK', 100,
        'STREAMS', this.streamKey, '>'
      );

      if (!result || result.length === 0) {
        return [];
      }

      const [, messages] = result[0];
      
      return messages.map(([id, fields]) => {
        const data = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        return { id, data: data.data };
      });
    } catch (error) {
      console.error('[BackgroundAuditArchiver] Failed to read from stream:', error);
      return [];
    }
  }

  async archiveToDatabase(entries) {
    if (entries.length === 0) return 0;

    const records = [];
    
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(entry.data);
        
        records.push({
          timestamp: new Date(parsed.timestamp),
          worldInstanceId: parsed.worldInstanceId,
          clientIp: parsed.clientIp,
          environment: parsed.environment,
          commandType: parsed.commandType,
          commandIndex: parsed.commandIndex,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          worldId: parsed.worldId,
          inputData: parsed.inputData,
          outputData: parsed.outputData,
          statusCode: parsed.statusCode,
          durationMs: parsed.durationMs,
          success: parsed.success ?? true,
          errorMessage: parsed.errorMessage,
          method: parsed.method,
          path: parsed.path
        });
      } catch (parseError) {
        console.error('[BackgroundAuditArchiver] Failed to parse entry:', parseError);
      }
    }

    if (records.length === 0) return 0;

    try {
      const result = await this.prisma.auditLog.createMany({
        data: records,
        skipDuplicates: true
      });

      return result.count;
    } catch (error) {
      console.error('[BackgroundAuditArchiver] Database insert failed:', error);
      throw error;
    }
  }

  async acknowledgeEntries(entries) {
    if (entries.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      
      for (const entry of entries) {
        pipeline.xack(this.streamKey, this.consumerGroup, entry.id);
      }
      
      await pipeline.exec();
    } catch (error) {
      console.error('[BackgroundAuditArchiver] Failed to acknowledge entries:', error);
    }
  }

  async getPendingCount() {
    try {
      const result = await this.redis.xpending(this.streamKey, this.consumerGroup);
      return result?.[0] || 0;
    } catch (error) {
      return 0;
    }
  }

  async getStreamLength() {
    try {
      return await this.redis.xlen(this.streamKey);
    } catch (error) {
      return 0;
    }
  }

  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize
    };
  }

  resetStats() {
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      commandsArchived: 0,
      lastRunTime: null,
      lastError: null,
      lastBatchSize: 0
    };
  }
}

export const backgroundAuditArchiver = new BackgroundAuditArchiver();