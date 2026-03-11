#!/usr/bin/env node

/**
 * Production startup script for backup worker
 * Validates environment and starts the worker with proper error handling
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('\n' + '='.repeat(60));
console.log('MSW Backup Worker - Production Startup');
console.log('='.repeat(60));

// Set production environment if not set
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  console.log('[Startup] NODE_ENV set to production');
}

// Required environment variables
const requiredEnvVars = [
  'DATABASE_URL',
  'CACHE_REDIS_URL',
  'EPHEMERAL_REDIS_URL',
  'STREAM_REDIS_URL',
  'BACKBLAZE_KEY_ID',
  'BACKBLAZE_KEY'
];

// Optional environment variables with defaults
const optionalEnvVars = {
  'BACKUP_ENABLED': 'true',
  'BACKUP_SCHEDULE': '0 */6 * * *',
  'BACKUP_RETENTION_DAYS': '7',
  'BACKUP_COMPRESSION_LEVEL': '6',
  'BACKUP_TEMP_DIR': '/tmp/msw-backups',
  'BACKUP_WORKER_PORT': '3001',
  'BACKUP_LOG_RETENTION_DAYS': '7'
};

// Validate required environment variables
console.log('\n[Startup] Validating environment variables...');
const missing = [];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    missing.push(key);
    console.error(`  ✗ ${key}: MISSING`);
  } else {
    console.log(`  ✓ ${key}: Set (${process.env[key].substring(0, 20)}...)`);
  }
}

if (missing.length > 0) {
  console.error(`\n[Startup] ERROR: Missing required environment variables: ${missing.join(', ')}`);
  console.error('[Startup] Please set these variables before starting the backup worker.\n');
  process.exit(1);
}

// Set optional environment variables with defaults
console.log('\n[Startup] Checking optional environment variables...');
for (const [key, defaultValue] of Object.entries(optionalEnvVars)) {
  if (!process.env[key]) {
    process.env[key] = defaultValue;
    console.log(`  ℹ ${key}: Using default (${defaultValue})`);
  } else {
    console.log(`  ✓ ${key}: ${process.env[key]}`);
  }
}

// Start the backup worker
console.log('\n[Startup] Starting backup worker...');
console.log('='.repeat(60) + '\n');

const workerPath = path.join(__dirname, '..', 'workers', 'backup-worker.js');
const worker = spawn('node', [workerPath], {
  stdio: 'inherit',
  env: process.env
});

// Handle worker events
worker.on('error', (error) => {
  console.error('[Startup] Failed to start backup worker:', error);
  process.exit(1);
});

worker.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[Startup] Backup worker killed by signal: ${signal}`);
    process.exit(1);
  } else if (code !== 0) {
    console.error(`[Startup] Backup worker exited with code: ${code}`);
    process.exit(code);
  } else {
    console.log('[Startup] Backup worker exited successfully');
    process.exit(0);
  }
});

// Forward signals to worker
process.on('SIGTERM', () => {
  console.log('[Startup] Forwarding SIGTERM to worker');
  worker.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('[Startup] Forwarding SIGINT to worker');
  worker.kill('SIGINT');
});
