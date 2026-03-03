#!/usr/bin/env node
import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';
import { config, cacheRedis, ephemeralRedis, streamRedis } from '../config.js';
import { ConfigHasher } from '../util/ConfigHasher.js';
import { BackblazeFileManager } from '../util/BackblazeFileManager.js';

function parseArgs(argv) {
  const args = {
    input: path.resolve(config.configSync.configDir, 'ui_plans.json'),
    output: path.resolve('config/ui_plans'),
    upload: false,
    env: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--input') {
      args.input = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--output') {
      args.output = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--upload') {
      args.upload = true;
    } else if (token === '--env') {
      args.env = argv[i + 1];
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/shard-ui-plans.js [--input <path>] [--output <dir>] [--upload --env <staging|production>]

Options:
  --input   Input ui_plans.json path (default: CONFIG_SYNC_DIR/ui_plans.json)
  --output  Output directory for sharded files (default: config/ui_plans)
  --upload  Upload generated shards to Backblaze B2
  --env     Environment bucket to upload to (required with --upload)
  --help    Show this message`);
}

function shutdownRedisConnections() {
  cacheRedis.disconnect();
  ephemeralRedis.disconnect();
  streamRedis.disconnect();
}

function toPlanRecords(payload) {
  if (Array.isArray(payload)) {
    return payload.map((item, index) => ({
      planId: String(item?.id ?? item?.planId ?? item?.name ?? index),
      data: item
    }));
  }

  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.plans)) {
      return payload.plans.map((item, index) => ({
        planId: String(item?.id ?? item?.planId ?? item?.name ?? index),
        data: item
      }));
    }

    return Object.entries(payload).map(([planId, data]) => ({
      planId: String(planId),
      data
    }));
  }

  throw new Error('ui_plans.json must be an object or an array');
}

async function uploadShardsIfRequested({ upload, env, output, filesToUpload }) {
  if (!upload) {
    return null;
  }

  if (!env || !config.allowedEnvironments.includes(env)) {
    throw new Error(`--env must be one of: ${config.allowedEnvironments.join(', ')}`);
  }

  const b2 = new BackblazeFileManager(config.backblaze);
  const bucketName = b2.getBucketName(env);
  if (!bucketName) {
    throw new Error(`No Backblaze bucket configured for environment ${env}`);
  }

  await b2.ensureAuthorized();
  const uploaded = [];
  try {
    for (const relativePath of filesToUpload) {
      const absolutePath = path.join(output, relativePath);
      const b2Path = `ui_plans/${relativePath}`.replace(/\\/g, '/');
      const result = await b2.uploadFile(absolutePath, b2Path, bucketName);
      uploaded.push({
        path: b2Path,
        fileId: result.fileId,
        sha256: result.sha256,
        size: result.size
      });
    }
  } finally {
    await b2.shutdown();
  }

  return uploaded;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    shutdownRedisConnections();
    return;
  }

  try {
    const hasher = new ConfigHasher();
    const rawContent = await fs.readFile(args.input, 'utf8');
    const payload = JSON.parse(rawContent);
    const planRecords = toPlanRecords(payload);

    const blobsDir = path.join(args.output, 'blobs');
    await fs.mkdir(blobsDir, { recursive: true });

    const index = {};
    const filesToUpload = ['index.json'];

    for (const record of planRecords) {
      const hash = hasher.computeObjectHash(record.data);
      index[record.planId] = hash;
      const blobPath = path.join(blobsDir, `${hash}.json`);
      await fs.writeFile(blobPath, JSON.stringify(record.data), 'utf8');
      filesToUpload.push(`blobs/${hash}.json`);
    }

    const indexPath = path.join(args.output, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    const uploaded = await uploadShardsIfRequested({
      upload: args.upload,
      env: args.env,
      output: args.output,
      filesToUpload
    });

    console.log(JSON.stringify({
      input: args.input,
      output: args.output,
      plans: planRecords.length,
      blobs: Object.keys(index).length,
      indexPath,
      uploaded
    }, null, 2));
  } finally {
    shutdownRedisConnections();
  }
}

main().catch(error => {
  console.error('Failed to shard ui_plans.json:', error.message);
  process.exit(1);
});
