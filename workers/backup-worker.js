/**
 * Backup Worker - Main worker process with cron scheduler
 * Runs on a separate port (default: 3001) to avoid impacting main server
 */

const cron = require('node-cron');
const express = require('express');
const config = require('../config');
const backupService = require('../services/BackupService');

// Worker state
const state = {
  startTime: Date.now(),
  lastBackup: null,
  lastBackupStatus: null,
  lastBackupDuration: null,
  nextBackup: null,
  totalBackupsRun: 0,
  isRunning: false,
  scheduledTask: null
};

// Create Express app for health endpoint
const app = express();
const PORT = config.backup.workerPort || 3001;

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const stats = await backupService.getStats();
    
    res.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      lastBackup: state.lastBackup,
      lastBackupStatus: state.lastBackupStatus,
      lastBackupDuration: state.lastBackupDuration,
      nextBackup: state.nextBackup,
      schedule: config.backup.schedule,
      totalBackupsRun: state.totalBackupsRun,
      isRunning: state.isRunning,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      uptime: Math.floor((Date.now() - state.startTime) / 1000)
    });
  }
});

// Simple ready check
app.get('/ready', (req, res) => {
  res.json({ ready: true });
});

// Manual trigger endpoint (for testing)
app.post('/trigger', async (req, res) => {
  if (state.isRunning) {
    return res.status(409).json({ error: 'Backup already running' });
  }

  res.json({ message: 'Backup triggered', timestamp: new Date().toISOString() });
  
  // Run backup asynchronously
  runBackup().catch(error => {
    console.error('[BackupWorker] Manual trigger error:', error);
  });
});

/**
 * Run a backup cycle
 */
async function runBackup() {
  if (state.isRunning) {
    console.log('[BackupWorker] Backup already running, skipping');
    return;
  }

  state.isRunning = true;
  const startTime = Date.now();

  try {
    console.log('[BackupWorker] Starting scheduled backup');
    
    const result = await backupService.runBackup();
    
    state.lastBackup = result.timestamp;
    state.lastBackupStatus = result.success ? 'success' : 'partial';
    state.lastBackupDuration = result.duration;
    state.totalBackupsRun++;

    console.log(`[BackupWorker] Backup completed: ${result.success ? 'SUCCESS' : 'PARTIAL'}`);
  } catch (error) {
    console.error('[BackupWorker] Backup failed:', error);
    state.lastBackupStatus = 'failed';
    state.lastBackupDuration = Date.now() - startTime;
  } finally {
    state.isRunning = false;
  }
}

/**
 * Calculate next scheduled run time
 */
function calculateNextRun() {
  const schedule = config.backup.schedule;
  
  try {
    // Get next 5 scheduled times
    const nextRuns = cron.scheduleTime(schedule, true, 5);
    
    if (nextRuns && nextRuns.length > 0) {
      const next = nextRuns[0];
      state.nextBackup = next.toISOString();
    }
  } catch (error) {
    console.error('[BackupWorker] Failed to calculate next run:', error);
  }
}

/**
 * Initialize scheduled backup task
 */
function initScheduler() {
  if (!config.backup.enabled) {
    console.log('[BackupWorker] Backups disabled, running in manual mode only');
    return;
  }

  const schedule = config.backup.schedule;
  
  // Validate cron expression
  if (!cron.validate(schedule)) {
    console.error(`[BackupWorker] Invalid cron schedule: ${schedule}`);
    process.exit(1);
  }

  console.log(`[BackupWorker] Scheduling backups with cron: ${schedule}`);
  
  // Schedule the backup task
  state.scheduledTask = cron.schedule(schedule, async () => {
    calculateNextRun();
    await runBackup();
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  // Calculate initial next run time
  calculateNextRun();
  
  console.log(`[BackupWorker] Scheduled task initialized, next run: ${state.nextBackup || 'calculating...'}`);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log(`\n[BackupWorker] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new backup requests
  if (state.scheduledTask) {
    state.scheduledTask.stop();
    console.log('[BackupWorker] Scheduled task stopped');
  }

  // Wait for current backup to complete (max 5 minutes)
  const shutdownTimeout = setTimeout(() => {
    console.log('[BackupWorker] Forced shutdown after timeout');
    process.exit(1);
  }, 5 * 60 * 1000);

  // Wait for backup to finish if running
  while (state.isRunning) {
    console.log('[BackupWorker] Waiting for backup to complete...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  clearTimeout(shutdownTimeout);

  console.log('[BackupWorker] Shutdown complete');
  process.exit(0);
}

// Process event handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('[BackupWorker] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[BackupWorker] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the worker
async function start() {
  console.log('\n' + '='.repeat(60));
  console.log('MSW Backup Worker');
  console.log('='.repeat(60));
  console.log(`Environment:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`Port:           ${PORT}`);
  console.log(`Backup Enabled: ${config.backup.enabled}`);
  console.log(`Schedule:       ${config.backup.schedule}`);
  console.log(`Retention:      ${config.backup.retentionDays} days`);
  console.log(`Temp Dir:       ${config.backup.tempDir}`);
  console.log(`B2 Bucket:      ${config.backup.b2Bucket}`);
  console.log('='.repeat(60) + '\n');

  // Validate required environment variables
  const requiredEnvVars = [
    'DATABASE_URL',
    'CACHE_REDIS_URL',
    'EPHEMERAL_REDIS_URL',
    'STREAM_REDIS_URL',
    'BACKBLAZE_KEY_ID',
    'BACKBLAZE_KEY'
  ];

  const missing = requiredEnvVars.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('[BackupWorker] Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`[BackupWorker] Health endpoint listening on port ${PORT}`);
    console.log(`[BackupWorker] Health check: http://localhost:${PORT}/health`);
    console.log(`[BackupWorker] Ready check:  http://localhost:${PORT}/ready\n`);
  });

  // Initialize backup scheduler
  initScheduler();

  // Run initial backup on startup (optional - comment out if not desired)
  // console.log('[BackupWorker] Running initial backup on startup...');
  // await runBackup();
}

// Start the worker
start().catch(error => {
  console.error('[BackupWorker] Startup failed:', error);
  process.exit(1);
});
