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
      <p class="subtitle">
        <a href="/metrics" style="color: #38bdf8;">JSON API</a> |
        <a href="/metrics/prometheus" style="color: #38bdf8;">Prometheus Metrics</a> |
        <a href="/health" style="color: #38bdf8;">Health Check</a>
      </p>
    </div>
  </div>

  <script>
    // Auto-refresh every 5 seconds
    setTimeout(() => location.reload(), 5000);
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
