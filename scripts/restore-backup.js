#!/usr/bin/env node

/**
 * Backup Restore Script - Interactive restore utility with safety confirmations
 * Usage:
 *   node scripts/restore-backup.js --list
 *   node scripts/restore-backup.js --timestamp 2025-03-11T06:00:00Z --dry-run
 *   node scripts/restore-backup.js --timestamp 2025-03-11T06:00:00Z --db-only
 *   node scripts/restore-backup.js --timestamp 2025-03-11T06:00:00Z --redis-only cache
 */

const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const B2 = require('backblaze-b2');
const Redis = require('ioredis');
const { spawn } = require('child_process');
const config = require('../config');

// Command-line arguments
const args = process.argv.slice(2);
const options = {
  list: args.includes('--list'),
  timestamp: getArgValue('--timestamp'),
  dryRun: args.includes('--dry-run'),
  dbOnly: args.includes('--db-only'),
  redisOnly: getArgValue('--redis-only'),
  force: args.includes('--force'),
  confirm: args.includes('--confirm')
};

function getArgValue(key) {
  const index = args.indexOf(key);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

// B2 client
let b2 = null;

async function initB2() {
  if (!b2) {
    b2 = new B2({
      applicationKeyId: process.env.BACKBLAZE_KEY_ID,
      applicationKey: process.env.BACKBLAZE_KEY
    });
    await b2.authorize();
  }
  return b2;
}

// Redis clients
const redisClients = {};

async function getRedisClient(name) {
  if (!redisClients[name]) {
    const envKey = `${name.toUpperCase()}_REDIS_URL`;
    if (!process.env[envKey]) {
      throw new Error(`Missing ${envKey} environment variable`);
    }
    redisClients[name] = new Redis(process.env[envKey]);
  }
  return redisClients[name];
}

/**
 * List available backups
 */
async function listBackups() {
  console.log('\n' + '='.repeat(80));
  console.log('Available Backups');
  console.log('='.repeat(80));

  try {
    await initB2();
    
    const bucketId = await getBucketId();
    const files = [];
    let startFileName = null;
    let hasMore = true;

    while (hasMore) {
      const response = await b2.listFileVersions({
        bucketId: bucketId,
        prefix: 'backups/',
        startFileName: startFileName,
        maxFileCount: 100
      });

      files.push(...(response.data.files || []));
      hasMore = response.data.nextFileId !== null;
      startFileName = response.data.nextFileName;
    }

    // Group files by timestamp
    const backups = {};
    
    for (const file of files) {
      const match = file.fileName.match(/backups\/(db|redis\/\w+)\/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
      if (match) {
        const type = match[1];
        const ts = match[2].replace(/_/g, 'T').replace(/-(\d{2})-(\d{2})-(\d{2})$/, ':$1:$2:$3Z');
        
        if (!backups[ts]) {
          backups[ts] = { timestamp: ts, db: null, redis: {} };
        }
        
        if (type === 'db') {
          backups[ts].db = {
            size: file.contentLength,
            fileId: file.fileId,
            fileName: file.fileName
          };
        } else {
          const instance = type.split('/')[1];
          backups[ts].redis[instance] = {
            size: file.contentLength,
            fileId: file.fileId,
            fileName: file.fileName
          };
        }
      }
    }

    // Sort by timestamp (latest first)
    const sortedBackups = Object.values(backups).sort((a, b) => 
      b.timestamp.localeCompare(a.timestamp)
    );

    if (sortedBackups.length === 0) {
      console.log('\nNo backups found.\n');
      return;
    }

    // Display table
    console.log(`\nFound ${sortedBackups.length} backup(s):\n`);
    
    console.log('┌─────────────────────────┬──────────┬───────────┬───────────┬───────────┐');
    console.log('│ Timestamp               │ DB Size  │ Cache     │ Ephemeral │ Stream    │');
    console.log('├─────────────────────────┼──────────┼───────────┼───────────┼───────────┤');

    for (const backup of sortedBackups.slice(0, 20)) {
      const ts = backup.timestamp.substring(0, 19);
      const dbSize = backup.db ? formatBytes(backup.db.size) : '—';
      const cache = backup.redis.cache ? formatBytes(backup.redis.cache.size) : '—';
      const ephemeral = backup.redis.ephemeral ? formatBytes(backup.redis.ephemeral.size) : '—';
      const stream = backup.redis.stream ? formatBytes(backup.redis.stream.size) : '—';
      
      console.log(`│ ${ts} │ ${dbSize.padEnd(8)} │ ${cache.padEnd(9)} │ ${ephemeral.padEnd(9)} │ ${stream.padEnd(9)} │`);
    }

    console.log('└─────────────────────────┴──────────┴───────────┴───────────┴───────────┘\n');

    if (sortedBackups.length > 20) {
      console.log(`(Showing 20 of ${sortedBackups.length} backups)\n`);
    }
  } catch (error) {
    console.error('\nFailed to list backups:', error.message);
    process.exit(1);
  }
}

/**
 * Restore from backup
 */
async function restore() {
  if (!options.timestamp) {
    console.error('\nError: --timestamp parameter is required');
    console.log('Usage: node scripts/restore-backup.js --timestamp 2025-03-11T06:00:00Z [options]\n');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('Restore Backup');
  console.log('='.repeat(80));
  console.log(`\nTimestamp: ${options.timestamp}`);
  console.log(`Mode: ${options.dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE RESTORE'}`);
  console.log(`Database: ${options.redisOnly ? 'SKIPPED' : (options.dbOnly ? 'INCLUDED' : 'INCLUDED')}`);
  console.log(`Redis: ${options.dbOnly ? 'SKIPPED' : (options.redisOnly || 'ALL INSTANCES')}`);
  console.log('');

  try {
    await initB2();
    
    // Download backup files
    const tempDir = path.join(config.backup.tempDir, 'restore', options.timestamp.replace(/[:.]/g, '-'));
    await fs.ensureDir(tempDir);

    // Restore database
    if (!options.redisOnly) {
      console.log('\n[1/2] Restoring Database...');
      await restoreDatabase(tempDir);
    }

    // Restore Redis
    if (!options.dbOnly) {
      console.log('\n[2/2] Restoring Redis...');
      const instances = options.redisOnly ? [options.redisOnly] : ['cache', 'ephemeral', 'stream'];
      
      for (const instance of instances) {
        await restoreRedis(instance, tempDir);
      }
    }

    // Cleanup
    await fs.remove(tempDir);

    console.log('\n' + '='.repeat(80));
    console.log(options.dryRun ? 'DRY RUN COMPLETE - No changes were made' : 'RESTORE COMPLETE');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\nRestore failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Restore database from backup
 */
async function restoreDatabase(tempDir) {
  const timestamp = options.timestamp.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const b2Path = `backups/db/${timestamp}.sql.gz`;
  const localPath = path.join(tempDir, 'db.sql.gz');

  console.log(`  Downloading: ${b2Path}`);
  
  try {
    await downloadFile(b2Path, localPath);
    console.log(`  ✓ Downloaded: ${formatBytes(await fs.stat(localPath).then(s => s.size))}`);

    if (options.dryRun) {
      console.log('  ℹ DRY RUN: Would restore database (skipped)');
      return;
    }

    // Require confirmation
    if (!options.confirm) {
      await confirmRestore('database');
    }

    console.log('  Restoring database...');
    
    const gunzip = spawn('gunzip', ['-c', localPath]);
    const psql = spawn('psql', [process.env.DATABASE_URL, '--quiet', '--no-psqlrc']);
    
    gunzip.stdout.pipe(psql.stdin);

    await new Promise((resolve, reject) => {
      psql.on('close', (code) => {
        if (code === 0) {
          console.log('  ✓ Database restored successfully');
          resolve();
        } else {
          reject(new Error(`psql exited with code ${code}`));
        }
      });
      psql.on('error', reject);
      gunzip.on('error', reject);
    });

  } catch (error) {
    if (error.message.includes('not found')) {
      console.log('  ⚠ Database backup not found, skipping');
    } else {
      throw error;
    }
  }
}

/**
 * Restore Redis instance from backup using DEBUG RELOAD (zero downtime)
 */
async function restoreRedis(instanceName, tempDir) {
  const timestamp = options.timestamp.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const b2Path = `backups/redis/${instanceName}/${timestamp}.rdb.gz`;
  const localPath = path.join(tempDir, `${instanceName}.rdb.gz`);
  const rdbPath = path.join(tempDir, `${instanceName}.rdb`);

  console.log(`\n  Restoring Redis: ${instanceName}`);
  console.log(`  Downloading: ${b2Path}`);

  try {
    await downloadFile(b2Path, localPath);
    console.log(`  ✓ Downloaded: ${formatBytes(await fs.stat(localPath).then(s => s.size))}`);

    if (options.dryRun) {
      console.log('  ℹ DRY RUN: Would restore Redis instance (skipped)');
      return;
    }

    // Require confirmation
    if (!options.confirm) {
      await confirmRestore(`Redis ${instanceName}`);
    }

    // Decompress RDB
    const gunzip = spawn('gunzip', ['-c', localPath]);
    const writeStream = fs.createWriteStream(rdbPath);
    gunzip.stdout.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      gunzip.on('error', reject);
    });

    // Read RDB content
    const rdbContent = await fs.readFile(rdbPath);
    const rdbBase64 = rdbContent.toString('base64');

    // Use DEBUG RELOAD for zero-downtime restore
    console.log(`  Executing DEBUG RELOAD (zero-downtime restore)...`);
    
    const redisClient = await getRedisClient(instanceName);
    await redisClient.send_command('DEBUG', ['RELOAD', rdbBase64]);

    console.log(`  ✓ Redis ${instanceName} restored successfully (no restart required)`);

    // Cleanup
    await fs.remove(rdbPath);

  } catch (error) {
    if (error.message.includes('not found')) {
      console.log(`  ⚠ Redis ${instanceName} backup not found, skipping`);
    } else {
      throw error;
    }
  }
}

/**
 * Download file from B2
 */
async function downloadFile(b2Path, localPath) {
  const bucketId = await getBucketId();
  
  const response = await b2.listFileVersions({
    bucketId: bucketId,
    prefix: b2Path,
    maxFileCount: 1
  });

  const file = response.data.files?.[0];
  
  if (!file) {
    throw new Error(`File not found: ${b2Path}`);
  }

  const downloadUrl = await b2.getDownloadUrl({ fileId: file.fileId });
  
  const https = require('https');
  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(localPath);
    https.get(downloadUrl.data.downloadUrl, (response) => {
      response.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Get bucket ID
 */
async function getBucketId() {
  const response = await b2.listBuckets();
  const bucket = response.data.buckets.find(b => b.bucketName === config.backup.b2Bucket);
  
  if (!bucket) {
    throw new Error(`Bucket not found: ${config.backup.b2Bucket}`);
  }
  
  return bucket.bucketId;
}

/**
 * Confirm restore with timestamp typing
 */
async function confirmRestore(target) {
  console.log(`\n${'⚠'.repeat(80)}`);
  console.log(`WARNING: This will REPLACE your current ${target} data!`);
  console.log(`Backup: ${options.timestamp}`);
  console.log(`${'⚠'.repeat(80)}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve, reject) => {
    rl.question(`To proceed, type the exact timestamp: `, (answer) => {
      rl.close();
      
      if (answer.trim() === options.timestamp) {
        console.log('✓ Confirmed\n');
        resolve();
      } else {
        console.log('✗ Timestamp does not match. Restore cancelled.\n');
        process.exit(1);
      }
    });
  });
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Main entry point
 */
async function main() {
  // Validate environment
  if (!process.env.BACKBLAZE_KEY_ID || !process.env.BACKBLAZE_KEY) {
    console.error('\nError: BACKBLAZE_KEY_ID and BACKBLAZE_KEY environment variables required\n');
    process.exit(1);
  }

  if (options.list) {
    await listBackups();
  } else {
    await restore();
  }

  // Cleanup Redis clients
  for (const client of Object.values(redisClients)) {
    client.disconnect();
  }
}

// Run
main().catch(error => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
