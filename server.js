// src/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, ephemeralRedis, streamRedis } from './config.js';
import { CommandProcessor } from './util/CommandProcessor.js';
import { rateLimiter } from './util/RateLimiter.js';
import { metrics } from './util/MetricsCollector.js';

const app = express();
const commandProcessor = new CommandProcessor();

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
        database: 'connected' // Prisma doesn't have a simple ping
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
app.get('/metrics/prometheus', (req, res) => {
  try {
    const prometheusMetrics = metrics.toPrometheusFormat();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(prometheusMetrics);
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

// Main batch processing endpoint
app.post('/process', async (req, res) => {
  const startTime = performance.now();
  
  try {
    // Process commands
    const results = await commandProcessor.processCommands(req.body);
    
    const processingTime = performance.now() - startTime;
    
    res.json({ 
      results,
      meta: {
        commandCount: commands.length,
        processingTimeMs: Math.round(processingTime),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    
    const processingTime = performance.now() - startTime;
    
    res.status(500).json({ 
      error: 'Internal server error',
      meta: {
        processingTimeMs: Math.round(processingTime),
        timestamp: new Date().toISOString()
      }
    });
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
