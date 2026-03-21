import { prisma, auditRedis, config } from '../config.js';
import { Prisma } from '@prisma/client';

export class AuditService {
  constructor(options = {}) {
    this.prisma = options.prisma || prisma;
    this.redis = options.redis || auditRedis;
    this.streamKey = config.audit.streamKey;
  }

  async getLogs(options = {}) {
    const {
      startDate,
      endDate,
      commandType,
      entityType,
      entityId,
      worldInstanceId,
      environment,
      success,
      limit = 100,
      offset = 0
    } = options;

    const where = {};

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = new Date(startDate);
      if (endDate) where.timestamp.lte = new Date(endDate);
    }

    if (commandType) where.commandType = commandType;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (worldInstanceId) where.worldInstanceId = worldInstanceId;
    if (environment) where.environment = environment;
    if (success !== undefined) where.success = success;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset
      }),
      this.prisma.auditLog.count({ where })
    ]);

    return { logs, total };
  }

  async getLogById(id) {
    return this.prisma.auditLog.findUnique({
      where: { id }
    });
  }

  async getRecentLogs(limit = 100) {
    try {
      const result = await this.redis.xrevrange(
        this.streamKey,
        '+',
        '-',
        'COUNT', limit
      );

      return result.map(([id, fields]) => {
        const data = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }
        try {
          return {
            id,
            ...JSON.parse(data.data || '{}')
          };
        } catch {
          return { id, parseError: true };
        }
      });
    } catch (error) {
      if (error.message?.includes('no such key')) {
        return [];
      }
      throw error;
    }
  }

  async getStats() {
    const [total, errors, avgDuration, streamLength] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.count({
        where: { success: false }
      }),
      this.prisma.auditLog.aggregate({
        _avg: { durationMs: true }
      }),
      this.getStreamLength()
    ]);

    return {
      total,
      errors,
      errorRate: total > 0 ? ((errors / total) * 100).toFixed(2) : 0,
      avgDuration: Math.round(avgDuration._avg.durationMs || 0),
      streamLength
    };
  }

  async getBreakdownStats(options = {}) {
    const where = this.buildWhere(options);

    const [commandBreakdown, entityBreakdown] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['commandType'],
        _count: { commandType: true },
        where,
        orderBy: { _count: { commandType: 'desc' } }
      }),
      this.prisma.auditLog.groupBy({
        by: ['entityType'],
        _count: { entityType: true },
        where: { ...where, entityType: { not: null } },
        orderBy: { _count: { entityType: 'desc' } },
        take: 20
      })
    ]);

    return {
      byCommandType: commandBreakdown.map(r => ({
        type: r.commandType,
        count: r._count.commandType
      })),
      byEntityType: entityBreakdown.map(r => ({
        type: r.entityType,
        count: r._count.entityType
      }))
    };
  }

  async getUniqueCommandTypes() {
    const result = await this.prisma.auditLog.findMany({
      where: { commandType: { not: 'request' } },
      select: { commandType: true },
      distinct: ['commandType']
    });
    return result.map(r => r.commandType).sort();
  }

  async getUniqueEntityTypes() {
    const result = await this.prisma.auditLog.findMany({
      where: { entityType: { not: null } },
      select: { entityType: true },
      distinct: ['entityType']
    });
    return result.map(r => r.entityType).filter(Boolean).sort();
  }

  async getErrorStats(options = {}) {
    const where = { ...this.buildWhere(options), success: false };

    const [byCommandType, recent] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['commandType'],
        where,
        _count: { commandType: true },
        orderBy: { _count: { commandType: 'desc' } }
      }),
      this.prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          timestamp: true,
          commandType: true,
          entityType: true,
          entityId: true,
          errorMessage: true
        },
        orderBy: { timestamp: 'desc' },
        take: 20
      })
    ]);

    return {
      byCommandType: byCommandType.map(r => ({
        type: r.commandType,
        count: r._count.commandType
      })),
      recent
    };
  }

  async getPerformanceStats(options = {}) {
    const where = this.buildWhere(options);

    const [avgByType, slowest] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['commandType'],
        where,
        _avg: { durationMs: true },
        _count: { commandType: true },
        orderBy: { _avg: { durationMs: 'desc' } }
      }),
      this.prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          timestamp: true,
          commandType: true,
          entityType: true,
          entityId: true,
          durationMs: true
        },
        orderBy: { durationMs: 'desc' },
        take: 20
      })
    ]);

    return {
      avgByCommandType: avgByType.map(r => ({
        type: r.commandType,
        avgDuration: Math.round(r._avg.durationMs || 0),
        count: r._count.commandType
      })),
      slowest
    };
  }

  async getRequestGroups(options = {}) {
    const logs = await this.prisma.auditLog.findMany({
      where: this.buildWhere(options),
      orderBy: [{ timestamp: 'asc' }, { commandIndex: 'asc' }],
      take: options.limit || 500
    });

    const groups = new Map();
    
    logs.forEach(log => {
      const key = `${log.timestamp.toISOString().slice(0, 19)}|${log.worldInstanceId || 'none'}`;
      
      if (!groups.has(key)) {
        groups.set(key, {
          timestamp: log.timestamp,
          worldInstanceId: log.worldInstanceId,
          environment: log.environment,
          commands: []
        });
      }
      
      groups.get(key).commands.push(log);
    });

    return Array.from(groups.values()).reverse();
  }

  async getHourlyVolume(hours = 24) {
    const result = await this.prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('hour', timestamp) as hour,
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration,
        COUNT(DISTINCT world_instance_id) as unique_worlds
      FROM audit_logs
      WHERE timestamp > NOW() - INTERVAL '${Prisma.raw(hours.toString())} hours'
      GROUP BY DATE_TRUNC('hour', timestamp)
      ORDER BY hour DESC
    `;

    return result.map(row => ({
      hour: row.hour,
      count: Number(row.count),
      avgDuration: Math.round(Number(row.avg_duration || 0)),
      uniqueWorlds: Number(row.unique_worlds || 0)
    }));
  }

  async getStreamLength() {
    try {
      return await this.redis.xlen(this.streamKey);
    } catch (error) {
      return 0;
    }
  }

  buildWhere(options = {}) {
    const where = {};

    if (options.startDate || options.endDate) {
      where.timestamp = {};
      if (options.startDate) where.timestamp.gte = new Date(options.startDate);
      if (options.endDate) where.timestamp.lte = new Date(options.endDate);
    }

    if (options.commandType) where.commandType = options.commandType;
    if (options.entityType) where.entityType = options.entityType;
    if (options.worldInstanceId) where.worldInstanceId = options.worldInstanceId;
    if (options.environment) where.environment = options.environment;
    if (options.success !== undefined) where.success = options.success;

    return where;
  }

  async cleanup(retentionDays = config.audit.dbRetentionDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        timestamp: { lt: cutoffDate }
      }
    });

    return result.count;
  }
}

export const auditService = new AuditService();