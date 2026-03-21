// src/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, cacheRedis, ephemeralRedis, streamRedis } from './config.js';
import { CommandProcessor } from './util/CommandProcessor.js';
import { rateLimiter } from './util/RateLimiter.js';
import { metrics } from './util/MetricsCollector.js';
import { ConfigManifestService } from './services/ConfigManifestService.js';
import { ConfigDiffService } from './services/ConfigDiffService.js';
import { ConfigLock } from './util/ConfigLock.js';
import { ConfigPollingService } from './services/ConfigPollingService.js';
import { ConfigHealthService } from './services/ConfigHealthService.js';
import { ConfigKeyGenerator } from './util/ConfigKeyGenerator.js';
import { configDashboard } from './monitoring/config-dashboard.js';
import { ALERT_RULES, evaluateConfigAlerts } from './monitoring/alerts.js';
import { ConfigSnapshotReader } from './services/ConfigSnapshotReader.js';
import { MobDropPreviewService } from './services/MobDropPreviewService.js';
import { auditLogger } from './util/AuditLogger.js';
import { backgroundAuditArchiver } from './util/BackgroundAuditArchiver.js';
import { auditService } from './services/AuditService.js';

const app = express();
const commandProcessor = new CommandProcessor();
const configManifestService = new ConfigManifestService({
  redis: cacheRedis,
  b2: commandProcessor.fileManager,
  configDir: config.configSync.configDir
});
const configDiffService = new ConfigDiffService({
  redis: cacheRedis,
  manifestService: configManifestService,
  b2: commandProcessor.fileManager,
  configDir: config.configSync.configDir
});
const configLock = new ConfigLock(cacheRedis);
const configHealthService = new ConfigHealthService({ redis: cacheRedis });
const configPollingService = new ConfigPollingService({
  manifestService: configManifestService,
  diffService: configDiffService,
  healthService: configHealthService,
  pollIntervalMs: config.configSync.pollIntervalMs
});
const configSnapshotReader = new ConfigSnapshotReader({
  manifestService: configManifestService,
  b2: commandProcessor.fileManager,
});
const mobDropPreviewService = new MobDropPreviewService({
  snapshotReader: configSnapshotReader,
});

if (config.configSync.enabled && commandProcessor.fileManager) {
  config.allowedEnvironments.forEach(environment => {
    configPollingService.startPolling(environment, config.configSync.pollIntervalMs);
  });
}

configPollingService.on('configUpdated', ({ environment, snapshotVersion }) => {
  configDashboard.recordPublish(environment, 0, snapshotVersion, 'poll-update');
});

configPollingService.on('pollError', ({ environment, error }) => {
  console.error(`[ConfigPollingService] ${environment} polling failed:`, error);
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting middleware - must be after body parsers
app.use(rateLimiter.middleware());

// Start audit archiver
if (config.audit.enabled) {
  backgroundAuditArchiver.start();
}

// Health check endpoint
// src/server.js - Updated health check
app.get('/health', async (req, res) => {
  try {
    const healthChecks = [
      commandProcessor.cache.healthCheck(),
      checkRedisHealth(ephemeralRedis, 'ephemeral'),
      checkRedisHealth(streamRedis, 'streams')
    ];

    // Add file sync health check if enabled
    if (commandProcessor.fileManager) {
      healthChecks.push(commandProcessor.fileManager.healthCheck());
    }

    const healthResults = await Promise.all(healthChecks);
    const [cacheHealth, ephemeralHealth, streamHealth, fileSyncHealth] = healthResults;

    const backgroundTaskStats = commandProcessor.getBackgroundTaskStats();

    const overallHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        cache: cacheHealth,
        ephemeral: ephemeralHealth,
        streams: streamHealth,
        database: 'connected', // Prisma doesn't have a simple ping
        configSync: {
          enabled: config.configSync.enabled,
          polling: config.configSync.enabled ? 'running' : 'disabled'
        }
      },
      backgroundTask: backgroundTaskStats
    };

    // Add file sync health if available
    if (fileSyncHealth) {
      overallHealth.services.fileSync = fileSyncHealth;
    }

    const allHealthy = healthResults
      .every(service => service.status === 'healthy');

    res.status(allHealthy ? 200 : 503).json(overallHealth);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Metrics summary endpoint
app.get('/metrics/summary', (req, res) => {
  try {
    const summary = metrics.getSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get metrics summary',
      message: error.message
    });
  }
});

// Full metrics endpoint
app.get('/metrics', (req, res) => {
  try {
    if (req.query.format === 'prometheus') {
      return res.redirect(307, '/metrics/prometheus');
    }

    const allMetrics = metrics.getAllMetrics();
    res.json(allMetrics);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get metrics',
      message: error.message
    });
  }
});

// Prometheus metrics endpoint
app.get('/metrics/prometheus', async (req, res) => {
  try {
    const coreMetrics = metrics.toPrometheusFormat();
    const configMetrics = await configDashboard.toPrometheus({
      environments: config.allowedEnvironments,
      healthService: configHealthService
    });

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(`${coreMetrics}\n${configMetrics}`);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to export Prometheus metrics',
      message: error.message
    });
  }
});

// Background task stats endpoint
app.get('/stats/background-task', (req, res) => {
  try {
    const stats = commandProcessor.getBackgroundTaskStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get background task stats',
      message: error.message
    });
  }
});

// File sync stats endpoint
app.get('/stats/file-sync', (req, res) => {
  try {
    const stats = commandProcessor.getFileSyncStats();
    if (!stats) {
      return res.status(404).json({
        error: 'File sync is not enabled or configured'
      });
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get file sync stats',
      message: error.message
    });
  }
});

// Audit stats endpoint
app.get('/audit/stats', async (req, res) => {
  try {
    const stats = await auditService.getStats();
    const archiverStats = backgroundAuditArchiver.getStats();
    res.json({
      ...stats,
      archiver: archiverStats
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit stats',
      message: error.message
    });
  }
});

// Audit breakdown stats (command types and entity types)
app.get('/audit/breakdown', async (req, res) => {
  try {
    const stats = await auditService.getBreakdownStats({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      worldInstanceId: req.query.worldInstanceId,
      environment: req.query.environment
    });
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit breakdown',
      message: error.message
    });
  }
});

// Audit error stats endpoint
app.get('/audit/errors', async (req, res) => {
  try {
    const stats = await auditService.getErrorStats({
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit error stats',
      message: error.message
    });
  }
});

// Audit performance stats endpoint
app.get('/audit/performance', async (req, res) => {
  try {
    const stats = await auditService.getPerformanceStats({
      startDate: req.query.startDate,
      endDate: req.query.endDate
    });
    res.json(stats);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit performance stats',
      message: error.message
    });
  }
});

// Audit logs endpoint with filtering
app.get('/audit/logs', async (req, res) => {
  try {
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
    } = req.query;

    const result = await auditService.getLogs({
      startDate,
      endDate,
      commandType,
      entityType,
      entityId,
      worldInstanceId,
      environment,
      success: success === 'true' ? true : success === 'false' ? false : undefined,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit logs',
      message: error.message
    });
  }
});

// Single audit log detail
app.get('/audit/logs/:id', async (req, res) => {
  try {
    const log = await auditService.getLogById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.json(log);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit log',
      message: error.message
    });
  }
});

// Recent audit logs from Redis stream
app.get('/audit/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await auditService.getRecentLogs(limit);
    res.json({ logs, count: logs.length });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get recent audit logs',
      message: error.message
    });
  }
});

// Audit filter options (unique command types and entity types)
app.get('/audit/filters', async (req, res) => {
  try {
    const [commandTypes, entityTypes] = await Promise.all([
      auditService.getUniqueCommandTypes(),
      auditService.getUniqueEntityTypes()
    ]);
    res.json({ commandTypes, entityTypes });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit filters',
      message: error.message
    });
  }
});

// Audit hourly volume
app.get('/audit/volume', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const volume = await auditService.getHourlyVolume(hours);
    res.json(volume);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get audit volume',
      message: error.message
    });
  }
});

// Request groups (group commands by request)
app.get('/audit/requests', async (req, res) => {
  try {
    const groups = await auditService.getRequestGroups({
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      worldInstanceId: req.query.worldInstanceId,
      limit: parseInt(req.query.limit) || 50
    });
    res.json({ groups, count: groups.length });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get request groups',
      message: error.message
    });
  }
});

function createApiError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getConfigSyncRequest(payload) {
  return payload?.configSync
    || (payload?.clientVersion !== undefined ? { clientVersion: payload.clientVersion } : null);
}

function validateConfigSyncRequestPayload(payload) {
  const configSyncRequest = getConfigSyncRequest(payload);
  if (!configSyncRequest) {
    return false;
  }

  const environment = payload?.environment;
  const parsedClientVersion = Number(configSyncRequest.clientVersion);

  if (!environment || !config.allowedEnvironments.includes(environment)) {
    throw createApiError(`environment must be one of: ${config.allowedEnvironments.join(', ')}`, 400);
  }

  if (!Number.isInteger(parsedClientVersion) || parsedClientVersion < 0) {
    throw createApiError('configSync.clientVersion must be a non-negative integer', 400);
  }

  return true;
}

async function resolveConfigSyncPayload(payload) {
  const configSyncRequest = getConfigSyncRequest(payload);

  if (!configSyncRequest) {
    return null;
  }

  const environment = payload?.environment;
  const parsedClientVersion = Number(configSyncRequest.clientVersion);

  try {
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      throw createApiError(`environment must be one of: ${config.allowedEnvironments.join(', ')}`, 400);
    }

    if (!Number.isInteger(parsedClientVersion) || parsedClientVersion < 0) {
      throw createApiError('configSync.clientVersion must be a non-negative integer', 400);
    }

    const currentManifest = await configManifestService.getCurrentManifest(environment);
    if (!currentManifest) {
      throw createApiError('No config manifest has been published for this environment', 404);
    }

    const currentVersion = Number(currentManifest.snapshotVersion);
    const versionLagSeconds = Math.max(0, currentVersion - parsedClientVersion);

    await configHealthService.reportClientVersion(parsedClientVersion, environment);
    await configHealthService.setCurrentVersion(currentVersion, environment);

    if (parsedClientVersion === currentVersion) {
      configDashboard.recordSyncRequest(environment, 'no_change', versionLagSeconds);
      return {
        noChange: true,
        currentVersion
      };
    }

    if (currentVersion - parsedClientVersion > config.configSync.maxVersionGapForDiff) {
      configDashboard.recordSyncRequest(environment, 'full_sync', versionLagSeconds);
      return {
        requiresFullSync: true,
        currentVersion
      };
    }

    const diff = await configDiffService.getDiff(parsedClientVersion, currentVersion, environment);
    if (!diff) {
      configDashboard.recordSyncRequest(environment, 'full_sync', versionLagSeconds);
      return {
        requiresFullSync: true,
        currentVersion
      };
    }

    configDashboard.recordSyncRequest(environment, 'diff', versionLagSeconds);
    return {
      snapshotVersion: currentVersion,
      diff,
      manifestId: currentManifest.manifestId || currentManifest.manifestHash
    };
  } catch (error) {
    if (environment && Number.isInteger(parsedClientVersion)) {
      await configHealthService.reportVersionError(parsedClientVersion, error.message, environment).catch(() => {});
      configDashboard.recordSyncRequest(environment, 'error', 0);
    }
    throw error;
  }
}

// Current config version endpoint
app.get('/config/version', async (req, res) => {
  try {
    const environment = req.query.environment;
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      return res.status(400).json({
        error: `environment query must be one of: ${config.allowedEnvironments.join(', ')}`
      });
    }

    const currentManifest = await configManifestService.getCurrentManifest(environment);
    if (!currentManifest) {
      return res.status(404).json({
        error: 'No config manifest has been published for this environment'
      });
    }

    await configHealthService.setCurrentVersion(currentManifest.snapshotVersion, environment);

    return res.json({
      currentVersion: currentManifest.snapshotVersion,
      manifestId: currentManifest.manifestId || currentManifest.manifestHash
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch config version',
      message: error.message
    });
  }
});

// Roll back config to a previous version
app.post('/config/rollback', async (req, res) => {
  const { targetVersion, environment } = req.body || {};

  if (!environment || !config.allowedEnvironments.includes(environment)) {
    return res.status(400).json({
      error: `environment must be one of: ${config.allowedEnvironments.join(', ')}`
    });
  }

  const parsedTargetVersion = Number(targetVersion);
  if (!Number.isInteger(parsedTargetVersion) || parsedTargetVersion < 0) {
    return res.status(400).json({
      error: 'targetVersion must be a non-negative integer'
    });
  }

  const lockResult = await configLock.acquirePublishLock(environment, 60, { maxRetries: 0 });
  if (!lockResult.acquired) {
    return res.status(409).json({
      error: 'Config publish lock is currently held by another operation'
    });
  }

  const startedAt = performance.now();
  try {
    const currentManifest = await configManifestService.getCurrentManifest(environment);
    if (!currentManifest) {
      return res.status(404).json({
        error: 'No current manifest available for rollback'
      });
    }

    if (parsedTargetVersion >= Number(currentManifest.snapshotVersion)) {
      return res.status(400).json({
        error: 'targetVersion must be lower than current active version'
      });
    }

    const rollbackManifest = await configManifestService.rollbackToVersion(parsedTargetVersion, environment);
    const durationSeconds = (performance.now() - startedAt) / 1000;
    configDashboard.recordPublish(environment, durationSeconds, rollbackManifest.snapshotVersion, rollbackManifest.label);
    configDashboard.recordRollback(environment, parsedTargetVersion, rollbackManifest.snapshotVersion);

    const auditEntry = {
      timestamp: new Date().toISOString(),
      environment,
      targetVersion: parsedTargetVersion,
      newVersion: rollbackManifest.snapshotVersion
    };

    const keyGenerator = new ConfigKeyGenerator(environment);
    await cacheRedis.lpush(keyGenerator.rollbackAuditLog(), JSON.stringify(auditEntry));
    await cacheRedis.ltrim(keyGenerator.rollbackAuditLog(), 0, 99);

    return res.json({
      success: true,
      newVersion: rollbackManifest.snapshotVersion,
      message: `Rolled back ${environment} config to version ${parsedTargetVersion}`
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to rollback config',
      message: error.message
    });
  } finally {
    await configLock.releasePublishLock(environment, lockResult.value);
  }
});

// Config version health endpoints
app.get('/config/health/:version', async (req, res) => {
  try {
    const environment = req.query.environment;
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      return res.status(400).json({
        error: `environment query must be one of: ${config.allowedEnvironments.join(', ')}`
      });
    }

    const health = await configHealthService.getVersionHealth(req.params.version, environment);
    return res.json(health);
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to get version health',
      message: error.message
    });
  }
});

app.post('/config/health/mark-bad', async (req, res) => {
  try {
    const { environment, version, reason } = req.body || {};
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      return res.status(400).json({
        error: `environment must be one of: ${config.allowedEnvironments.join(', ')}`
      });
    }

    await configHealthService.markVersionBad(version, reason, environment);
    const health = await configHealthService.getVersionHealth(version, environment);
    return res.json({ success: true, health });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to mark version as bad',
      message: error.message
    });
  }
});

// Simple active alerts endpoint
app.get('/config/alerts', async (req, res) => {
  try {
    const environment = req.query.environment;
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      return res.status(400).json({
        error: `environment query must be one of: ${config.allowedEnvironments.join(', ')}`
      });
    }

    const currentManifest = await configManifestService.getCurrentManifest(environment);
    const currentVersion = currentManifest?.snapshotVersion ?? null;
    const alerts = await evaluateConfigAlerts({
      environment,
      currentVersion,
      healthService: configHealthService,
      dashboardMetrics: configDashboard
    });

    return res.json({
      environment,
      currentVersion,
      activeAlerts: alerts,
      rules: ALERT_RULES
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to evaluate config alerts',
      message: error.message
    });
  }
});

// Config dashboard endpoint
app.get('/config/mob-drops/preview', async (req, res) => {
  try {
    const environment = req.query.environment;
    if (!environment || !config.allowedEnvironments.includes(environment)) {
      return res.status(400).json({
        error: `environment query must be one of: ${config.allowedEnvironments.join(', ')}`
      });
    }

    const parsedMobId = Number(req.query.mobId);
    if (!Number.isInteger(parsedMobId) || parsedMobId <= 0) {
      return res.status(400).json({
        error: 'mobId query must be a positive integer'
      });
    }

    const preview = await mobDropPreviewService.previewMobDrops({
      environment,
      mobId: parsedMobId,
    });
    return res.json(preview);
  } catch (error) {
    if (error.code === 'mob_not_found') {
      return res.status(404).json({
        error: error.message,
      });
    }
    if (error.code === 'invalid_mob_id') {
      return res.status(400).json({
        error: error.message,
      });
    }
    if (error.code === 'missing_snapshot_files' || error.code === 'snapshot_backend_unavailable') {
      return res.status(503).json({
        error: error.message,
        missingData: error.missingData || [],
      });
    }

    return res.status(500).json({
      error: 'Failed to build mob drop preview',
      message: error.message,
    });
  }
});

// Backup API endpoints
app.get('/api/backups/history', async (req, res) => {
  try {
    const backupService = require('./services/BackupService');
    const backups = await backupService.listBackups(20);
    res.json({ backups, total: backups.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups/stats', async (req, res) => {
  try {
    const backupService = require('./services/BackupService');
    const RetentionManager = require('./services/RetentionManager');
    const fetch = require('node-fetch');
    
    const retentionManager = new RetentionManager(config);
    const stats = await backupService.getStats();
    const storageStats = await retentionManager.getStats();
    
    const backups = await backupService.listBackups(100);
    const successfulBackups = backups.filter(b => b.success);
    const failedBackups = backups.filter(b => !b.success);
    
    const avgDuration = successfulBackups.length > 0
      ? successfulBackups.reduce((sum, b) => sum + (b.duration || 0), 0) / successfulBackups.length
      : 0;
    
    const avgSize = successfulBackups.length > 0
      ? successfulBackups.reduce((sum, b) => sum + (b.totalSize || 0), 0) / successfulBackups.length
      : 0;
    
    const successRate = backups.length > 0
      ? (successfulBackups.length / backups.length) * 100
      : 0;
    
    let scheduleInfo = {};
    try {
      const response = await fetch(`http://localhost:${config.backup.workerPort}/health`);
      const health = await response.json();
      scheduleInfo = {
        enabled: config.backup.enabled,
        cron: config.backup.schedule,
        retentionDays: config.backup.retentionDays,
        nextBackup: health.nextBackup,
        lastBackup: health.lastBackup
      };
    } catch (error) {
      scheduleInfo = {
        enabled: config.backup.enabled,
        cron: config.backup.schedule,
        retentionDays: config.backup.retentionDays,
        nextBackup: null,
        lastBackup: null
      };
    }
    
    res.json({
      storage: storageStats,
      performance: {
        successRate: successRate.toFixed(1),
        avgDuration: Math.round(avgDuration),
        avgSize: Math.round(avgSize),
        totalBackups: backups.length,
        failedBackups: failedBackups.length
      },
      schedule: scheduleInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backups/restore', async (req, res) => {
  try {
    const { timestamp, type } = req.body;
    
    if (!timestamp) {
      return res.status(400).json({ error: 'Timestamp required' });
    }
    
    const restoreId = `restore-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    await cacheRedis.setex(
      `restore:${restoreId}`,
      300,
      JSON.stringify({ timestamp, type, createdAt: Date.now() })
    );
    
    const warning = type === 'full' 
      ? 'This will REPLACE ALL your current data (database + all Redis instances)'
      : type === 'db-only'
      ? 'This will REPLACE your current database'
      : `This will REPLACE your current ${type.replace('redis-', 'Redis ')} data`;
    
    res.json({
      restoreId,
      timestamp,
      type,
      warning,
      requiresConfirmation: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/backups/restore/confirm', async (req, res) => {
  try {
    const { restoreId, confirmTimestamp } = req.body;
    
    if (!restoreId || !confirmTimestamp) {
      return res.status(400).json({ error: 'restoreId and confirmTimestamp required' });
    }
    
    const restoreData = await cacheRedis.get(`restore:${restoreId}`);
    
    if (!restoreData) {
      return res.status(404).json({ error: 'Restore request not found or expired' });
    }
    
    const { timestamp, type, createdAt } = JSON.parse(restoreData);
    
    if (confirmTimestamp !== timestamp) {
      return res.status(400).json({ error: 'Timestamp confirmation does not match' });
    }
    
    const { spawn } = require('child_process');
    const args = ['scripts/restore-backup.js', '--timestamp', timestamp, '--confirm'];
    
    if (type === 'db-only') {
      args.push('--db-only');
    } else if (type && type.startsWith('redis-')) {
      args.push('--redis-only', type.replace('redis-', ''));
    }
    
    const restoreProcess = spawn('node', args);
    
    let output = '';
    let errorOutput = '';
    
    restoreProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    restoreProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    restoreProcess.on('close', (code) => {
      cacheRedis.del(`restore:${restoreId}`);
      
      if (code === 0) {
        const resultId = `result-${Date.now()}`;
        cacheRedis.setex(
          `restore-result:${resultId}`,
          3600,
          JSON.stringify({
            success: true,
            timestamp,
            type,
            output,
            duration: Date.now() - createdAt
          })
        );
        
        res.json({
          success: true,
          restoreId,
          resultId,
          status: 'completed'
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorOutput || 'Restore failed',
          output
        });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/restore-result/:resultId', async (req, res) => {
  try {
    const resultData = await cacheRedis.get(`restore-result:${req.params.resultId}`);
    
    if (!resultData) {
      return res.status(404).send('Restore result not found or expired');
    }
    
    const result = JSON.parse(resultData);
    
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Restore Complete</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 40px;
            max-width: 800px;
            margin: 0 auto;
          }
          .success { color: #22c55e; }
          .card {
            background: #1e293b;
            border-radius: 8px;
            padding: 30px;
            border: 1px solid #334155;
          }
          .detail {
            margin: 15px 0;
            padding: 10px;
            background: #0f172a;
            border-radius: 4px;
          }
          .btn {
            display: inline-block;
            background: #38bdf8;
            color: #0f172a;
            padding: 10px 20px;
            border-radius: 6px;
            text-decoration: none;
            font-weight: 600;
            margin-top: 20px;
          }
          pre {
            background: #0f172a;
            padding: 15px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 0.875rem;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1 class="success">✓ Restore Completed Successfully</h1>
          
          <div class="detail">
            <strong>Timestamp:</strong> ${result.timestamp}
          </div>
          
          <div class="detail">
            <strong>Type:</strong> ${result.type}
          </div>
          
          <div class="detail">
            <strong>Duration:</strong> ${result.duration}ms
          </div>
          
          <h3 style="margin-top: 30px;">Output Log:</h3>
          <pre>${result.output}</pre>
          
          <a href="/dashboard" class="btn">← Back to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error loading restore result');
  }
});

app.get('/dashboard/config', async (req, res) => {
  try {
    const data = await configDashboard.getDashboardData({
      environments: config.allowedEnvironments,
      manifestService: configManifestService,
      healthService: configHealthService
    });
    const html = configDashboard.renderDashboardHTML(data);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to render config dashboard',
      message: error.message
    });
  }
});

// Metrics dashboard HTML endpoint
app.get('/dashboard', (req, res) => {
  const html = generateDashboardHTML();
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

function generateDashboardHTML() {
  const summary = metrics.getSummary();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MSW Backend - Metrics Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 10px; color: #38bdf8; }
    .subtitle { color: #94a3b8; margin-bottom: 30px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .card {
      background: #1e293b;
      border-radius: 8px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .card h2 { font-size: 0.875rem; color: #94a3b8; text-transform: uppercase; margin-bottom: 10px; }
    .card .value { font-size: 2rem; font-weight: 700; color: #38bdf8; }
    .card .label { font-size: 0.75rem; color: #64748b; margin-top: 5px; }
    .section { margin-bottom: 40px; }
    .section-title { font-size: 1.5rem; margin-bottom: 20px; color: #f1f5f9; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
    td { color: #e2e8f0; }
    .success-rate { color: #22c55e; font-weight: 600; }
    .low { color: #ef4444; }
    .medium { color: #f59e0b; }
    .high { color: #22c55e; }
    .refresh-btn {
      background: #38bdf8;
      color: #0f172a;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .refresh-btn:hover { background: #7dd3fc; }
    .restore-btn {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background 0.2s;
    }
    .restore-btn:hover { background: #2563eb; }
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.8);
      overflow-y: auto;
    }
    .modal-content {
      background: #1e293b;
      margin: 3% auto;
      padding: 30px;
      border: 1px solid #334155;
      border-radius: 8px;
      width: 90%;
      max-width: 600px;
      color: #e2e8f0;
    }
    .modal-content h2 { margin-top: 0; }
    .warning-box {
      background: #7f1d1d;
      border: 1px solid #ef4444;
      padding: 15px;
      border-radius: 6px;
      margin: 20px 0;
      font-weight: 600;
    }
    .backup-details {
      background: #0f172a;
      padding: 15px;
      border-radius: 6px;
      margin: 20px 0;
    }
    .backup-details ul { list-style: none; padding-left: 0; }
    .backup-details li { padding: 5px 0; color: #94a3b8; }
    .restore-options { margin: 20px 0; }
    .restore-options label {
      display: block;
      padding: 10px;
      margin: 5px 0;
      background: #0f172a;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .restore-options label:hover { background: #1e293b; }
    .restore-options input[type="radio"] { margin-right: 10px; }
    .confirmation-input input[type="text"] {
      width: 100%;
      padding: 12px;
      margin-top: 10px;
      background: #0f172a;
      border: 2px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      font-family: 'Courier New', monospace;
      font-size: 0.875rem;
    }
    .confirmation-input input[type="text"]:focus {
      outline: none;
      border-color: #38bdf8;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 25px;
    }
    .cancel-btn {
      background: #475569;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s;
    }
    .cancel-btn:hover { background: #64748b; }
    .confirm-btn {
      background: #ef4444;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.875rem;
      transition: background 0.2s;
    }
    .confirm-btn:disabled {
      background: #475569;
      cursor: not-allowed;
      opacity: 0.6;
    }
    .confirm-btn:not(:disabled):hover { background: #dc2626; }
  </style>
</head>
<body>
  <div class="container">
    <h1>MSW Backend Metrics Dashboard</h1>
    <p class="subtitle">Real-time performance and system metrics</p>

    <button class="refresh-btn" onclick="location.reload()">Refresh Data</button>

    <div class="section">
      <h3 class="section-title">Overview</h3>
      <div class="grid">
        <div class="card">
          <h2>Total Commands</h2>
          <div class="value">${summary.overview.totalCommands.toLocaleString()}</div>
          <div class="label">All time</div>
        </div>
        <div class="card">
          <h2>Success Rate</h2>
          <div class="value ${summary.overview.overallSuccessRate >= 95 ? 'high' : summary.overview.overallSuccessRate >= 90 ? 'medium' : 'low'}">${summary.overview.overallSuccessRate.toFixed(2)}%</div>
          <div class="label">${summary.overview.totalErrors} errors</div>
        </div>
        <div class="card">
          <h2>Cache Hit Rate</h2>
          <div class="value ${summary.overview.cacheHitRate >= 80 ? 'high' : summary.overview.cacheHitRate >= 60 ? 'medium' : 'low'}">${summary.overview.cacheHitRate.toFixed(2)}%</div>
          <div class="label">Cache performance</div>
        </div>
        <div class="card">
          <h2>Avg Response Time</h2>
          <div class="value">${summary.overview.averageResponseTime}ms</div>
          <div class="label">Per request</div>
        </div>
        <div class="card">
          <h2>System Uptime</h2>
          <div class="value">${Math.floor(summary.overview.uptime / 60)}m</div>
          <div class="label">${summary.overview.uptime}s total</div>
        </div>
        <div class="card">
          <h2>Rate Limit Block Rate</h2>
          <div class="value">${summary.rateLimiting.blockRate}%</div>
          <div class="label">${summary.rateLimiting.blocked} blocked</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">Commands by Type</h3>
      <table>
        <thead>
          <tr>
            <th>Command Type</th>
            <th>Count</th>
            <th>Success Rate</th>
            <th>Avg Duration (ms)</th>
          </tr>
        </thead>
        <tbody>
          ${summary.commands.map(cmd => `
            <tr>
              <td>${cmd.type}</td>
              <td>${cmd.count.toLocaleString()}</td>
              <td class="success-rate ${cmd.successRate >= 95 ? 'high' : cmd.successRate >= 90 ? 'medium' : 'low'}">${cmd.successRate.toFixed(2)}%</td>
              <td>${cmd.avgDuration}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3 class="section-title">Cache Performance by Entity Type</h3>
      <table>
        <thead>
          <tr>
            <th>Entity Type</th>
            <th>Hits</th>
            <th>Misses</th>
            <th>Hit Rate</th>
          </tr>
        </thead>
        <tbody>
          ${summary.cache.byEntityType.map(entity => `
            <tr>
              <td>${entity.entityType}</td>
              <td>${entity.hits.toLocaleString()}</td>
              <td>${entity.misses.toLocaleString()}</td>
              <td class="${parseFloat(entity.hitRate) >= 80 ? 'high' : parseFloat(entity.hitRate) >= 60 ? 'medium' : 'low'}">${entity.hitRate}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3 class="section-title">Database Operations by Entity Type</h3>
      <table>
        <thead>
          <tr>
            <th>Entity Type</th>
            <th>Loads</th>
            <th>Saves</th>
          </tr>
        </thead>
        <tbody>
          ${summary.database.byEntityType.map(entity => `
            <tr>
              <td>${entity.entityType}</td>
              <td>${entity.loads.toLocaleString()}</td>
              <td>${entity.saves.toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3 class="section-title">Stream Metrics by Entity Type</h3>
      <table>
        <thead>
          <tr>
            <th>Entity Type</th>
            <th>Messages Pushed</th>
            <th>Messages Pulled</th>
          </tr>
        </thead>
        <tbody>
          ${summary.streams.byEntityType.map(entity => `
            <tr>
              <td>${entity.entityType}</td>
              <td>${entity.pushed.toLocaleString()}</td>
              <td>${entity.pulled.toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3 class="section-title">Additional Metrics</h3>
      <div class="grid">
        <div class="card">
          <h2>Background Tasks</h2>
          <div class="value">${summary.backgroundTasks.entitiesPersisted}</div>
          <div class="label">Entities persisted</div>
        </div>
        <div class="card">
          <h2>Lock Contention</h2>
          <div class="value">${summary.locks.contentionRate}%</div>
          <div class="label">${summary.locks.failed} failed acquisitions</div>
        </div>
        <div class="card">
          <h2>P95 Latency</h2>
          <div class="value">${summary.performance.p95}ms</div>
          <div class="label">95th percentile</div>
        </div>
        <div class="card">
          <h2>P99 Latency</h2>
          <div class="value">${summary.performance.p99}ms</div>
          <div class="label">99th percentile</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">Backup Metrics</h3>
      <div class="grid">
        <div class="card">
          <h2>Success Rate</h2>
          <div class="value" id="backup-success-rate">—</div>
          <div class="label">Last 20 backups</div>
        </div>
        <div class="card">
          <h2>Storage Used</h2>
          <div class="value" id="backup-storage">—</div>
          <div class="label">Total in B2</div>
        </div>
        <div class="card">
          <h2>Avg Backup Time</h2>
          <div class="value" id="backup-avg-time">—</div>
          <div class="label">Duration</div>
        </div>
        <div class="card">
          <h2>Next Backup</h2>
          <div class="value" id="backup-next-run">—</div>
          <div class="label">Scheduled</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">Backup History (Last 20)</h3>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Size</th>
            <th>DB</th>
            <th>Cache</th>
            <th>Ephem</th>
            <th>Stream</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="backup-history-tbody">
          <tr><td colspan="9" style="text-align: center;">Loading...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="section">
      <h3 class="section-title">Storage Statistics</h3>
      <div class="grid">
        <div class="card">
          <h2>Database Backups</h2>
          <div class="value" id="backup-db-count">—</div>
          <div class="label" id="backup-db-size">0 MB</div>
        </div>
        <div class="card">
          <h2>Redis Backups</h2>
          <div class="value" id="backup-redis-count">—</div>
          <div class="label" id="backup-redis-size">0 MB</div>
        </div>
        <div class="card">
          <h2>Oldest Backup</h2>
          <div class="value" style="font-size: 1rem;" id="backup-oldest">—</div>
          <div class="label">Retention: 7 days</div>
        </div>
        <div class="card">
          <h2>Schedule</h2>
          <div class="value" style="font-size: 1rem;" id="backup-schedule">—</div>
          <div class="label" id="backup-enabled">Status</div>
        </div>
      </div>
    </div>

    <!-- Restore Modal -->
    <div id="restoreModal" class="modal">
      <div class="modal-content">
        <h2>⚠️ Confirm Restore</h2>
        <p>You are about to restore backup from:</p>
        <p><strong id="modal-timestamp"></strong></p>
        
        <div class="warning-box">
          ⚠️ WARNING: <span id="modal-warning"></span>
          <br>All current data will be lost!
        </div>
        
        <div class="backup-details" id="modal-details">
          <h3>Backup Details:</h3>
          <ul id="modal-details-list"></ul>
        </div>
        
        <div class="restore-options">
          <h3 style="margin-bottom: 10px;">Restore Type:</h3>
          <label>
            <input type="radio" name="restoreType" value="db-only" checked>
            Database Only (Recommended)
          </label>
          <label>
            <input type="radio" name="restoreType" value="redis-cache">
            Redis Cache Only
          </label>
          <label>
            <input type="radio" name="restoreType" value="redis-ephemeral">
            Redis Ephemeral Only
          </label>
          <label>
            <input type="radio" name="restoreType" value="redis-stream">
            Redis Stream Only
          </label>
          <label>
            <input type="radio" name="restoreType" value="full">
            ⚠️ Full Restore (ALL DATA)
          </label>
        </div>
        
        <div class="confirmation-input">
          <label>
            To proceed, type the exact timestamp:<br>
            <strong id="modal-confirm-timestamp"></strong>
          </label>
          <input type="text" id="confirmTimestamp" 
                 placeholder="Type timestamp here" autocomplete="off">
        </div>
        
        <div class="modal-actions">
          <button onclick="closeRestoreModal()" class="cancel-btn">
            Cancel
          </button>
          <button onclick="executeRestore()" 
                  class="confirm-btn" 
                  id="confirmRestoreBtn" 
                  disabled>
            Confirm Restore
          </button>
        </div>
      </div>
    </div>

    ${summary.clientMetrics.groups.length > 0 ? `
    <div class="section">
      <h3 class="section-title">Client-Submitted Metrics</h3>
      <div class="grid">
        <div class="card">
          <h2>Total Client Metrics</h2>
          <div class="value">${summary.clientMetrics.total.toLocaleString()}</div>
          <div class="label">All time</div>
        </div>
        <div class="card">
          <h2>Metric Groups</h2>
          <div class="value">${summary.clientMetrics.groups.length}</div>
          <div class="label">Unique groups</div>
        </div>
      </div>
      <table style="margin-top: 20px;">
        <thead>
          <tr>
            <th>Group</th>
            <th>Count</th>
            <th>Mean</th>
            <th>Median</th>
            <th>Sum</th>
            <th>Min</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          ${summary.clientMetrics.groups.map(metric => `
            <tr>
              <td><strong>${metric.group}</strong></td>
              <td>${metric.count.toLocaleString()}</td>
              <td>${metric.mean}</td>
              <td>${metric.median}</td>
              <td>${metric.sum}</td>
              <td>${metric.min}</td>
              <td>${metric.max}</td>
            </tr>
            ${metric.tagBreakdown.length > 0 ? metric.tagBreakdown.map(tag => `
              <tr style="background: #0f172a;">
                <td style="padding-left: 30px; color: #94a3b8;">${JSON.stringify(tag.tags)}</td>
                <td style="color: #94a3b8;">${tag.count.toLocaleString()}</td>
                <td style="color: #94a3b8;">${tag.mean}</td>
                <td style="color: #94a3b8;">${tag.median}</td>
                <td style="color: #94a3b8;">${tag.sum}</td>
                <td style="color: #94a3b8;">${tag.min}</td>
                <td style="color: #94a3b8;">${tag.max}</td>
              </tr>
            `).join('') : ''}
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <div class="section">
      <h3 class="section-title">Audit Logs</h3>
      <div class="grid">
        <div class="card">
          <h2>Total Commands</h2>
          <div class="value" id="audit-total">—</div>
          <div class="label">Logged</div>
        </div>
        <div class="card">
          <h2>Errors</h2>
          <div class="value" id="audit-errors">—</div>
          <div class="label" id="audit-error-rate">0% error rate</div>
        </div>
        <div class="card">
          <h2>Archived</h2>
          <div class="value" id="audit-archived">—</div>
          <div class="label">To database</div>
        </div>
        <div class="card">
          <h2>Stream Buffer</h2>
          <div class="value" id="audit-stream-length">—</div>
          <div class="label">Pending archival</div>
        </div>
      </div>
      
      <div style="background: #1e293b; padding: 20px; border-radius: 8px; margin-top: 20px;">
        <h4 style="margin-bottom: 15px; color: #94a3b8;">Filters</h4>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
          <div>
            <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.7rem;">Command Type</label>
            <select id="filter-commandType" style="width: 100%; padding: 6px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.8rem;">
              <option value="">All</option>
            </select>
          </div>
          <div>
            <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.7rem;">Entity Type</label>
            <select id="filter-entityType" style="width: 100%; padding: 6px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.8rem;">
              <option value="">All</option>
            </select>
          </div>
          <div>
            <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.7rem;">World Instance</label>
            <input type="text" id="filter-worldInstanceId" placeholder="Search..." style="width: 100%; padding: 6px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.8rem;">
          </div>
          <div>
            <label style="display: block; margin-bottom: 4px; color: #64748b; font-size: 0.7rem;">Status</label>
            <select id="filter-success" style="width: 100%; padding: 6px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: #e2e8f0; font-size: 0.8rem;">
              <option value="">All</option>
              <option value="true">Success</option>
              <option value="false">Failed</option>
            </select>
          </div>
        </div>
        <div style="margin-top: 10px;">
          <button onclick="applyAuditFilters()" class="refresh-btn" style="padding: 6px 12px; font-size: 0.8rem;">Apply</button>
          <button onclick="clearAuditFilters()" style="background: #475569; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-left: 8px; font-size: 0.8rem;">Clear</button>
        </div>
      </div>
      
      <div class="grid" style="margin-top: 20px;">
        <div class="card">
          <h2>By Command Type</h2>
          <div id="command-breakdown" style="margin-top: 10px; max-height: 200px; overflow-y: auto;"></div>
        </div>
        <div class="card">
          <h2>By Entity Type</h2>
          <div id="entity-breakdown" style="margin-top: 10px; max-height: 200px; overflow-y: auto;"></div>
        </div>
      </div>
      
      <table style="margin-top: 20px;">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Command</th>
            <th>Entity Type</th>
            <th>Entity ID</th>
            <th>World Instance</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="audit-logs-tbody">
          <tr><td colspan="8" style="text-align: center;">Loading...</td></tr>
        </tbody>
      </table>
      
      <div style="margin-top: 15px; display: flex; justify-content: space-between; align-items: center;">
        <span id="audit-pagination-info" style="color: #94a3b8; font-size: 0.8rem;"></span>
        <div>
          <button id="audit-prev-btn" onclick="prevAuditPage()" style="background: #475569; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-right: 8px; font-size: 0.8rem;">Prev</button>
          <button id="audit-next-btn" onclick="nextAuditPage()" style="background: #38bdf8; color: #0f172a; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Next</button>
        </div>
      </div>
    </div>

    <div class="section">
      <p class="subtitle">
        <a href="/metrics" style="color: #38bdf8;">JSON API</a> |
        <a href="/metrics/prometheus" style="color: #38bdf8;">Prometheus Metrics</a> |
        <a href="/health" style="color: #38bdf8;">Health Check</a> |
        <a href="/audit/stats" style="color: #38bdf8;">Audit Stats</a>
      </p>
    </div>
  </div>

  <div id="logDetailModal" class="modal">
    <div class="modal-content" style="max-width: 900px;">
      <h2>Command Detail</h2>
      <div id="log-detail-content"></div>
      <div class="modal-actions">
        <button onclick="closeLogDetailModal()" class="cancel-btn">Close</button>
      </div>
    </div>
  </div>

  <script>
    // Auto-refresh every 5 seconds
    setTimeout(() => location.reload(), 5000);
    
    let auditPage = 0;
    const auditPageSize = 50;
    
    // Backup functionality
    let currentRestoreTimestamp = null;
    let currentRestoreData = null;
    
    async function loadBackupData() {
      try {
        const [historyRes, statsRes] = await Promise.all([
          fetch('/api/backups/history'),
          fetch('/api/backups/stats')
        ]);
        
        const history = await historyRes.json();
        const stats = await statsRes.json();
        
        document.getElementById('backup-success-rate').textContent = stats.performance.successRate + '%';
        document.getElementById('backup-success-rate').className = 'value ' + (parseFloat(stats.performance.successRate) >= 95 ? 'high' : parseFloat(stats.performance.successRate) >= 90 ? 'medium' : 'low');
        
        const totalMB = (stats.storage.totalBytes / 1024 / 1024).toFixed(1);
        document.getElementById('backup-storage').textContent = totalMB + ' MB';
        
        const avgSec = (stats.performance.avgDuration / 1000).toFixed(1);
        document.getElementById('backup-avg-time').textContent = avgSec + 's';
        
        if (stats.schedule.nextBackup) {
          const next = new Date(stats.schedule.nextBackup);
          const now = new Date();
          const diffMs = next - now;
          const diffHours = Math.floor(diffMs / 3600000);
          const diffMins = Math.floor((diffMs % 3600000) / 60000);
          document.getElementById('backup-next-run').textContent = diffMs > 0 ? (diffHours > 0 ? diffHours + 'h ' + diffMins + 'm' : diffMins + 'm') : 'Now';
        } else {
          document.getElementById('backup-next-run').textContent = '—';
        }
        
        const tbody = document.getElementById('backup-history-tbody');
        tbody.innerHTML = history.backups.map(backup => {
          const date = new Date(backup.timestamp);
          const formatted = date.toLocaleString();
          const statusIcon = backup.success ? '✓' : '✗';
          const statusClass = backup.success ? 'high' : 'low';
          const duration = (backup.duration / 1000).toFixed(1) + 's';
          const size = (backup.totalSize / 1024 / 1024).toFixed(2) + ' MB';
          const dbStatus = backup.database?.success ? '✓' : '—';
          const cacheStatus = backup.redis?.cache?.success ? '✓' : '—';
          const ephemStatus = backup.redis?.ephemeral?.success ? '✓' : '—';
          const streamStatus = backup.redis?.stream?.success ? '✓' : '—';
          const backupData = JSON.stringify(backup).replace(/"/g, '&quot;');
          return '<tr><td>' + formatted + '</td><td class="' + statusClass + '">' + statusIcon + '</td><td>' + duration + '</td><td>' + size + '</td><td>' + dbStatus + '</td><td>' + cacheStatus + '</td><td>' + ephemStatus + '</td><td>' + streamStatus + '</td><td><button onclick="showRestoreModal(\'' + backup.timestamp + '\', ' + backupData + ')" class="restore-btn">Restore</button></td></tr>';
        }).join('');
        
        document.getElementById('backup-db-count').textContent = stats.storage.byType.db.count;
        document.getElementById('backup-db-size').textContent = (stats.storage.byType.db.bytes / 1024 / 1024).toFixed(1) + ' MB';
        document.getElementById('backup-redis-count').textContent = stats.storage.byType.redis.count;
        document.getElementById('backup-redis-size').textContent = (stats.storage.byType.redis.bytes / 1024 / 1024).toFixed(1) + ' MB';
        
        if (stats.storage.oldestBackup) {
          const oldest = new Date(stats.storage.oldestBackup);
          document.getElementById('backup-oldest').textContent = oldest.toLocaleDateString();
        }
        
        document.getElementById('backup-schedule').textContent = stats.schedule.cron || '—';
        document.getElementById('backup-enabled').textContent = stats.schedule.enabled ? 'Enabled' : 'Disabled';
      } catch (error) {
        console.error('Failed to load backup data:', error);
      }
    }
    
    function showRestoreModal(timestamp, backupData) {
      currentRestoreTimestamp = timestamp;
      currentRestoreData = backupData;
      
      document.getElementById('modal-timestamp').textContent = timestamp;
      document.getElementById('modal-confirm-timestamp').textContent = timestamp;
      document.getElementById('confirmTimestamp').value = '';
      document.getElementById('confirmRestoreBtn').disabled = true;
      document.getElementById('confirmRestoreBtn').textContent = 'Confirm Restore';
      document.querySelector('input[name="restoreType"][value="db-only"]').checked = true;
      updateWarningText('db-only');
      
      const detailsList = document.getElementById('modal-details-list');
      detailsList.innerHTML = '<li>Database: ' + (backupData.database?.success ? (backupData.database.size / 1024 / 1024).toFixed(2) + ' MB' : 'Failed') + '</li><li>Redis Cache: ' + (backupData.redis?.cache?.success ? (backupData.redis.cache.size / 1024 / 1024).toFixed(2) + ' MB' : 'Failed') + '</li><li>Redis Ephemeral: ' + (backupData.redis?.ephemeral?.success ? (backupData.redis.ephemeral.size / 1024 / 1024).toFixed(2) + ' MB' : 'Failed') + '</li><li>Redis Stream: ' + (backupData.redis?.stream?.success ? (backupData.redis.stream.size / 1024 / 1024).toFixed(2) + ' MB' : 'Failed') + '</li>';
      
      document.getElementById('restoreModal').style.display = 'block';
      
      document.getElementById('confirmTimestamp').addEventListener('input', function(e) {
        document.getElementById('confirmRestoreBtn').disabled = e.target.value !== timestamp;
      });
      
      document.querySelectorAll('input[name="restoreType"]').forEach(function(radio) {
        radio.addEventListener('change', function(e) {
          updateWarningText(e.target.value);
        });
      });
    }
    
    function updateWarningText(type) {
      var warningText = {
        'db-only': 'This will REPLACE your current database!',
        'redis-cache': 'This will REPLACE your current Redis cache data!',
        'redis-ephemeral': 'This will REPLACE your current Redis ephemeral data!',
        'redis-stream': 'This will REPLACE your current Redis stream data!',
        'full': 'This will REPLACE ALL your current data (database + all Redis instances)!'
      };
      document.getElementById('modal-warning').textContent = warningText[type] || warningText['db-only'];
    }
    
    async function executeRestore() {
      var restoreType = document.querySelector('input[name="restoreType"]:checked').value;
      var confirmTimestamp = document.getElementById('confirmTimestamp').value;
      
      if (confirmTimestamp !== currentRestoreTimestamp) {
        alert('Timestamp does not match!');
        return;
      }
      
      var confirmBtn = document.getElementById('confirmRestoreBtn');
      confirmBtn.textContent = 'Restoring...';
      confirmBtn.disabled = true;
      
      try {
        var initResponse = await fetch('/api/backups/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: currentRestoreTimestamp, type: restoreType })
        });
        var initData = await initResponse.json();
        if (!initResponse.ok) throw new Error(initData.error || 'Failed to initiate restore');
        
        var confirmResponse = await fetch('/api/backups/restore/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restoreId: initData.restoreId, confirmTimestamp: currentRestoreTimestamp })
        });
        var confirmData = await confirmResponse.json();
        if (!confirmResponse.ok) throw new Error(confirmData.error || 'Restore failed');
        
        window.location.href = '/restore-result/' + confirmData.resultId;
      } catch (error) {
        alert('Restore failed: ' + error.message);
        confirmBtn.textContent = 'Confirm Restore';
        confirmBtn.disabled = false;
      }
    }
    
    function closeRestoreModal() {
      document.getElementById('restoreModal').style.display = 'none';
    }
    
    async function loadAuditFilters() {
      try {
        const res = await fetch('/audit/filters');
        const data = await res.json();
        
        const cmdSelect = document.getElementById('filter-commandType');
        const entSelect = document.getElementById('filter-entityType');
        
        (data.commandTypes || []).forEach(type => {
          const opt = document.createElement('option');
          opt.value = type;
          opt.textContent = type;
          cmdSelect.appendChild(opt);
        });
        
        (data.entityTypes || []).forEach(type => {
          const opt = document.createElement('option');
          opt.value = type;
          opt.textContent = type;
          entSelect.appendChild(opt);
        });
      } catch (error) {
        console.error('Failed to load audit filters:', error);
      }
    }
    
    async function loadAuditBreakdown() {
      try {
        const res = await fetch('/audit/breakdown');
        const data = await res.json();
        
        const cmdContainer = document.getElementById('command-breakdown');
        const cmdTotal = (data.byCommandType || []).reduce((sum, c) => sum + c.count, 0);
        cmdContainer.innerHTML = (data.byCommandType || []).slice(0, 10).map(c => {
          const pct = cmdTotal > 0 ? ((c.count / cmdTotal) * 100).toFixed(0) : 0;
          return '<div style="margin-bottom: 6px;"><div style="display: flex; justify-content: space-between; font-size: 0.75rem;"><span>' + c.type + '</span><span>' + c.count.toLocaleString() + '</span></div><div style="background: #0f172a; border-radius: 3px; height: 4px; margin-top: 2px;"><div style="background: #38bdf8; height: 100%; border-radius: 3px; width: ' + pct + '%;"></div></div></div>';
        }).join('');
        
        const entContainer = document.getElementById('entity-breakdown');
        const entTotal = (data.byEntityType || []).reduce((sum, e) => sum + e.count, 0);
        entContainer.innerHTML = (data.byEntityType || []).slice(0, 10).map(e => {
          const pct = entTotal > 0 ? ((e.count / entTotal) * 100).toFixed(0) : 0;
          return '<div style="margin-bottom: 6px;"><div style="display: flex; justify-content: space-between; font-size: 0.75rem;"><span>' + e.type + '</span><span>' + e.count.toLocaleString() + '</span></div><div style="background: #0f172a; border-radius: 3px; height: 4px; margin-top: 2px;"><div style="background: #22c55e; height: 100%; border-radius: 3px; width: ' + pct + '%;"></div></div></div>';
        }).join('');
      } catch (error) {
        console.error('Failed to load audit breakdown:', error);
      }
    }
    
    async function loadAuditLogs() {
      try {
        const params = new URLSearchParams();
        params.set('limit', auditPageSize);
        params.set('offset', auditPage * auditPageSize);
        
        const commandType = document.getElementById('filter-commandType').value;
        const entityType = document.getElementById('filter-entityType').value;
        const worldInstanceId = document.getElementById('filter-worldInstanceId').value;
        const success = document.getElementById('filter-success').value;
        
        if (commandType) params.set('commandType', commandType);
        if (entityType) params.set('entityType', entityType);
        if (worldInstanceId) params.set('worldInstanceId', worldInstanceId);
        if (success) params.set('success', success);
        
        const res = await fetch('/audit/logs?' + params.toString());
        const data = await res.json();
        
        const tbody = document.getElementById('audit-logs-tbody');
        if (data.logs && data.logs.length > 0) {
          tbody.innerHTML = data.logs.map(log => {
            const date = new Date(log.timestamp);
            const statusClass = log.success ? 'high' : 'low';
            return '<tr><td style="font-size: 0.8rem;">' + date.toLocaleString() + '</td><td>' + log.commandType + '</td><td>' + (log.entityType || '—') + '</td><td style="font-size: 0.75rem; max-width: 100px; overflow: hidden; text-overflow: ellipsis;">' + (log.entityId || '—') + '</td><td style="font-size: 0.75rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis;">' + (log.worldInstanceId || '—') + '</td><td class="' + statusClass + '">' + (log.success ? '✓' : '✗') + '</td><td>' + (log.durationMs || 0) + 'ms</td><td><button onclick="showLogDetail(\'' + log.id + '\')" style="background: #3b82f6; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 0.7rem;">View</button></td></tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #94a3b8;">No commands logged</td></tr>';
        }
        
        const total = data.total || 0;
        const start = auditPage * auditPageSize + 1;
        const end = Math.min((auditPage + 1) * auditPageSize, total);
        document.getElementById('audit-pagination-info').textContent = total > 0 ? 'Showing ' + start + '-' + end + ' of ' + total.toLocaleString() : 'No results';
        
        document.getElementById('audit-prev-btn').disabled = auditPage === 0;
        document.getElementById('audit-next-btn').disabled = end >= total;
      } catch (error) {
        console.error('Failed to load audit logs:', error);
      }
    }
    
    async function loadAuditStats() {
      try {
        const res = await fetch('/audit/stats');
        const stats = await res.json();
        
        document.getElementById('audit-total').textContent = stats.total?.toLocaleString() || '0';
        document.getElementById('audit-errors').textContent = stats.errors?.toLocaleString() || '0';
        document.getElementById('audit-error-rate').textContent = stats.errorRate + '% error rate';
        document.getElementById('audit-archived').textContent = stats.archiver?.commandsArchived?.toLocaleString() || '0';
        document.getElementById('audit-stream-length').textContent = stats.streamLength?.toLocaleString() || '0';
      } catch (error) {
        console.error('Failed to load audit stats:', error);
      }
    }
    
    async function showLogDetail(id) {
      try {
        const res = await fetch('/audit/logs/' + id);
        const log = await res.json();
        
        const content = document.getElementById('log-detail-content');
        content.innerHTML = '<div style="margin-bottom: 15px;"><strong>Command:</strong> ' + log.commandType + '</div>' +
          '<div style="margin-bottom: 15px;"><strong>Entity:</strong> ' + (log.entityType || '—') + ' / ' + (log.entityId || '—') + '</div>' +
          '<div style="margin-bottom: 15px;"><strong>World Instance:</strong> ' + (log.worldInstanceId || '—') + '</div>' +
          '<div style="margin-bottom: 15px;"><strong>Status:</strong> ' + (log.success ? 'Success' : 'Failed') + '</div>' +
          '<div style="margin-bottom: 15px;"><strong>Duration:</strong> ' + (log.durationMs || 0) + 'ms</div>' +
          (log.errorMessage ? '<div style="margin-bottom: 15px; color: #ef4444;"><strong>Error:</strong> ' + log.errorMessage + '</div>' : '') +
          '<h4 style="margin-top: 20px; margin-bottom: 10px;">Input Data</h4>' +
          '<pre style="background: #0f172a; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; max-height: 200px;">' + JSON.stringify(log.inputData, null, 2) + '</pre>' +
          '<h4 style="margin-top: 15px; margin-bottom: 10px;">Output Data</h4>' +
          '<pre style="background: #0f172a; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; max-height: 200px;">' + JSON.stringify(log.outputData, null, 2) + '</pre>';
        
        document.getElementById('logDetailModal').style.display = 'block';
      } catch (error) {
        console.error('Failed to load log detail:', error);
      }
    }
    
    function closeLogDetailModal() {
      document.getElementById('logDetailModal').style.display = 'none';
    }
    
    function applyAuditFilters() {
      auditPage = 0;
      loadAuditLogs();
      loadAuditBreakdown();
    }
    
    function clearAuditFilters() {
      document.getElementById('filter-commandType').value = '';
      document.getElementById('filter-entityType').value = '';
      document.getElementById('filter-worldInstanceId').value = '';
      document.getElementById('filter-success').value = '';
      applyAuditFilters();
    }
    
    function prevAuditPage() {
      if (auditPage > 0) {
        auditPage--;
        loadAuditLogs();
      }
    }
    
    function nextAuditPage() {
      auditPage++;
      loadAuditLogs();
    }
    
    loadBackupData();
    loadAuditStats();
    loadAuditFilters();
    loadAuditBreakdown();
    loadAuditLogs();
  </script>
</body>
</html>
  `;
}

async function checkRedisHealth(redis, serviceName) {
  try {
    const ping = await redis.ping();
    return {
      status: 'healthy',
      service: serviceName,
      response: ping
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      service: serviceName,
      error: error.message
    };
  }
}

// Main CloudRunner endpoint
app.post('/cloudrun', async (req, res) => {
  const startTime = performance.now();

  try {
    const hasConfigSyncRequest = validateConfigSyncRequestPayload(req.body);
    const commandResponse = await commandProcessor.processCloudRun(req.body);
    const configSyncResponse = hasConfigSyncRequest ? await resolveConfigSyncPayload(req.body) : null;

    if (configSyncResponse) {
      return res.json({
        ...commandResponse,
        configSync: configSyncResponse
      });
    }

    return res.json(commandResponse);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) {
      console.error('API Error:', error);
    }

    const processingTime = performance.now() - startTime;

    const response = {
      error: statusCode >= 500 ? 'Internal server error' : error.message,
      meta: {
        processingTimeMs: Math.round(processingTime),
        timestamp: new Date().toISOString()
      }
    };

    if (error.details) {
      response.details = error.details;
    }

    res.status(statusCode).json(response);
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');

  configPollingService.shutdown();

  // Stop background tasks first (includes file sync)
  await commandProcessor.stopBackgroundTasks();

  // Close database connections
  await commandProcessor.persistentManager.prisma.$disconnect();

  // Close Redis connections
  commandProcessor.ephemeralManager.redis.disconnect();
  commandProcessor.streamManager.redis.disconnect();
  commandProcessor.cache.redis.disconnect();

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');

  configPollingService.shutdown();

  // Stop background tasks first (includes file sync)
  await commandProcessor.stopBackgroundTasks();

  // Close database connections
  await commandProcessor.persistentManager.prisma.$disconnect();

  // Close Redis connections
  commandProcessor.ephemeralManager.redis.disconnect();
  commandProcessor.streamManager.redis.disconnect();
  commandProcessor.cache.redis.disconnect();

  process.exit(0);
});

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

export default app;
