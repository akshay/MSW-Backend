#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';
import { config, cacheRedis, ephemeralRedis, streamRedis } from '../config.js';
import { BackblazeFileManager } from '../util/BackblazeFileManager.js';
import { ConfigManifestService } from '../services/ConfigManifestService.js';
import { ConfigValidator } from '../util/ConfigValidator.js';
import { ConfigLock } from '../util/ConfigLock.js';
import { ConfigKeyGenerator } from '../util/ConfigKeyGenerator.js';
import { isTrackedConfigManifestFile } from '../util/ConfigManifestFileRegistry.js';

function parseArgs(argv) {
  const result = {
    command: 'publish',
    env: null,
    label: null,
    dryRun: false,
    version: null,
    configDir: null,
    help: false
  };

  const tokens = [...argv];
  if (tokens[0] === 'rollback') {
    result.command = 'rollback';
    tokens.shift();
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--env') {
      result.env = tokens[i + 1];
      i += 1;
    } else if (token === '--label') {
      result.label = tokens[i + 1];
      i += 1;
    } else if (token === '--dry-run') {
      result.dryRun = true;
    } else if (token === '--version') {
      result.version = Number(tokens[i + 1]);
      i += 1;
    } else if (token === '--config-dir') {
      result.configDir = tokens[i + 1];
      i += 1;
    } else if (token === '--help' || token === '-h') {
      result.help = true;
    }
  }

  return result;
}

function printHelp() {
  console.log(`Usage:
  node scripts/publish-config.js --env <staging|production> [--label <string>] [--dry-run] [--config-dir <path>]
  node scripts/publish-config.js rollback --version <N> --env <staging|production>

Options:
  --env         Target environment (required)
  --label       Optional label for the published snapshot
  --dry-run     Validate only; do not upload or publish
  --version     Rollback target version (required in rollback mode)
  --config-dir  Override config root directory
  --help        Show this message`);
}

function shutdownRedisConnections() {
  cacheRedis.disconnect();
  ephemeralRedis.disconnect();
  streamRedis.disconnect();
}

function validateEnvironment(environment) {
  if (!environment || !config.allowedEnvironments.includes(environment)) {
    throw new Error(`--env must be one of: ${config.allowedEnvironments.join(', ')}`);
  }
}

async function collectJsonFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectJsonFiles(absolutePath);
      files.push(...nested);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function validateConfigFiles(configDir) {
  const jsonFiles = await collectJsonFiles(configDir);
  let validatedCount = 0;
  for (const filePath of jsonFiles) {
    const relativePath = path.relative(configDir, filePath).split(path.sep).join('/');
    if (!isTrackedConfigManifestFile(relativePath)) {
      continue;
    }
    validatedCount += 1;

    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const validation = ConfigValidator.validateNoNullMarker(parsed);
    if (!validation.valid) {
      return {
        valid: false,
        filePath,
        path: validation.path
      };
    }
  }

  return {
    valid: true,
    fileCount: validatedCount
  };
}

async function runRollback({ environment, version, manifestService, lock, redis }) {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('--version must be a non-negative integer for rollback');
  }

  const lockResult = await lock.acquirePublishLock(environment, 60);
  if (!lockResult.acquired) {
    throw new Error('Could not acquire publish lock');
  }

  try {
    const rollbackManifest = await manifestService.rollbackToVersion(version, environment);
    const audit = {
      timestamp: new Date().toISOString(),
      environment,
      targetVersion: version,
      newVersion: rollbackManifest.snapshotVersion
    };
    const keys = new ConfigKeyGenerator(environment);
    await redis.lpush(keys.rollbackAuditLog(), JSON.stringify(audit));
    await redis.ltrim(keys.rollbackAuditLog(), 0, 99);

    return {
      success: true,
      mode: 'rollback',
      environment,
      targetVersion: version,
      snapshotVersion: rollbackManifest.snapshotVersion
    };
  } finally {
    await lock.releasePublishLock(environment, lockResult.value);
  }
}

async function runPublish({ environment, label, dryRun, configDir, manifestService, lock }) {
  const validation = await validateConfigFiles(configDir);
  if (!validation.valid) {
    throw new Error(`NULL_MARKER collision in ${validation.filePath} at ${validation.path}`);
  }

  const currentManifest = await manifestService.getCurrentManifest(environment);
  const nextVersion = Number(currentManifest?.snapshotVersion || 0) + 1;
  const manifest = await manifestService.createManifest(configDir, {
    label,
    snapshotVersion: nextVersion
  });

  if (dryRun) {
    return {
      success: true,
      mode: 'dry-run',
      environment,
      snapshotVersion: manifest.snapshotVersion,
      files: Object.keys(manifest.files).length
    };
  }

  const lockResult = await lock.acquirePublishLock(environment, 60);
  if (!lockResult.acquired) {
    throw new Error('Could not acquire publish lock');
  }

  const startedAt = performance.now();
  try {
    const publishedManifest = await manifestService.publishManifest(manifest, environment, { configDir });
    const durationSeconds = (performance.now() - startedAt) / 1000;
    return {
      success: true,
      mode: 'publish',
      environment,
      snapshotVersion: publishedManifest.snapshotVersion,
      manifestId: publishedManifest.manifestId,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      files: Object.keys(publishedManifest.files || {}).length
    };
  } finally {
    await lock.releasePublishLock(environment, lockResult.value);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    shutdownRedisConnections();
    return;
  }

  validateEnvironment(args.env);

  const configDir = path.resolve(args.configDir || config.configSync.configDir);
  const b2 = new BackblazeFileManager(config.backblaze);
  const lock = new ConfigLock(cacheRedis);
  const manifestService = new ConfigManifestService({
    redis: cacheRedis,
    b2,
    configDir
  });

  await b2.ensureAuthorized();

  try {
    const output = args.command === 'rollback'
      ? await runRollback({
          environment: args.env,
          version: args.version,
          manifestService,
          lock,
          redis: cacheRedis
        })
      : await runPublish({
          environment: args.env,
          label: args.label,
          dryRun: args.dryRun,
          configDir,
          manifestService,
          lock
        });

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await b2.shutdown();
    shutdownRedisConnections();
  }
}

main().catch(error => {
  console.error(`Config publish script failed: ${error.message}`);
  process.exit(1);
});
