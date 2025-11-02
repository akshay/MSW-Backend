# File Synchronization API Documentation

## Overview

The MSW Backend now supports automatic file synchronization with Backblaze B2 cloud storage. This feature enables clients to efficiently download and stay synchronized with files stored in B2, with support for:

- Automatic background synchronization (every 60 seconds by default)
- Version tracking with SHA256 hash verification
- Progressive downloads with offset support
- Bandwidth-limited responses (10MB max, 90% allocation)
- Separate staging and production environments

## Configuration

### Environment Variables

Add the following to your `.env` file:

```env
# Backblaze B2 Configuration (Required)
BACKBLAZE_KEY_ID=your_backblaze_key_id_here
BACKBLAZE_KEY=your_backblaze_key_here
BACKBLAZE_STAGING_BUCKET=your_staging_bucket_name
BACKBLAZE_PRODUCTION_BUCKET=your_production_bucket_name

# File Sync Settings (Optional)
FILE_SYNC_ENABLED=true              # Enable/disable file sync (default: false)
FILE_SYNC_INTERVAL_MS=60000         # Sync interval in milliseconds (default: 60000 = 1 minute)
```

### Installation

The Backblaze B2 SDK has already been installed:

```bash
npm install backblaze-b2
```

## Request Format

### New Parameters in `/process` Endpoint

The existing POST `/process` endpoint now accepts two additional optional parameters:

#### 1. `files` (Map<string, string>)

A mapping of file names to their current SHA256 hash values. The server will check if these hashes match the cached versions.

**Example:**
```json
{
  "environment": "production",
  "encrypted": "...",
  "nonce": "...",
  "auth": "...",
  "worldInstanceId": "...",
  "commands": { ... },
  "files": {
    "config.json": "a1b2c3d4e5f6...",
    "assets/map.dat": "9f8e7d6c5b4a...",
    "scripts/init.lua": "3c4d5e6f7a8b..."
  }
}
```

#### 2. `downloads` (Map<string, DownloadInfo>)

A mapping of file names to download progress information. Used for progressive file downloads.

**DownloadInfo Structure:**
```typescript
{
  hash: string,           // Expected hash (must match current version)
  bytesReceived: number   // How many bytes already downloaded (offset)
}
```

**Example:**
```json
{
  "environment": "production",
  "encrypted": "...",
  "nonce": "...",
  "auth": "...",
  "worldInstanceId": "...",
  "commands": { ... },
  "files": {
    "config.json": "a1b2c3d4e5f6...",
    "assets/map.dat": "9f8e7d6c5b4a..."
  },
  "downloads": {
    "assets/map.dat": {
      "hash": "9f8e7d6c5b4a...",
      "bytesReceived": 1048576
    }
  }
}
```

## Response Format

### File Mismatch Response

When file hashes don't match, the response includes a `fileMismatches` field:

```json
{
  "results": { ... },
  "fileMismatches": {
    "config.json": {
      "expectedHash": "b2c3d4e5f6a7...",
      "fileSize": 2048
    },
    "assets/map.dat": {
      "expectedHash": "a8b7c6d5e4f3...",
      "fileSize": 10485760
    }
  }
}
```

**Fields:**
- `expectedHash`: The SHA256 hash of the current file version on the server
- `fileSize`: The total file size in bytes

### File Download Response

When downloads are requested, the response includes a `fileDownloads` field:

```json
{
  "results": { ... },
  "fileDownloads": {
    "assets/map.dat": {
      "hash": "a8b7c6d5e4f3...",
      "fileSize": 10485760,
      "offset": 1048576,
      "bytesInChunk": 4194304,
      "remainingBytes": 5242880,
      "chunk": "base64_encoded_file_content_here...",
      "complete": false
    }
  }
}
```

**Fields:**
- `hash`: SHA256 hash of the complete file
- `fileSize`: Total size of the file in bytes
- `offset`: Starting byte position of this chunk
- `bytesInChunk`: Number of bytes in this chunk
- `remainingBytes`: Number of bytes left to download after this chunk
- `chunk`: Base64-encoded file content
- `complete`: `true` if this is the final chunk, `false` otherwise

### Error Responses

If a file download fails, the response includes an error:

```json
{
  "results": { ... },
  "fileDownloads": {
    "missing.dat": {
      "error": "File not found"
    },
    "wrong_version.dat": {
      "error": "Hash mismatch",
      "expectedHash": "a1b2c3d4e5f6...",
      "fileSize": 2048
    }
  }
}
```

**Possible Errors:**
- `"File not found"`: Requested file doesn't exist in the cache
- `"Hash mismatch"`: Client's hash doesn't match the current version
- `"Failed to read file"`: Internal server error reading the file

## Client Implementation Guide

### Step 1: Initial File List Request

Send a request with the `files` parameter containing your current file hashes:

```javascript
const response = await fetch('/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    environment: 'production',
    encrypted: '...',
    nonce: '...',
    auth: '...',
    worldInstanceId: '...',
    commands: { /* your commands */ },
    files: {
      'config.json': currentConfigHash,
      'assets/map.dat': currentMapHash
    }
  })
});

const data = await response.json();
```

### Step 2: Handle File Mismatches

If `fileMismatches` is present, initiate downloads:

```javascript
if (data.fileMismatches) {
  for (const [fileName, info] of Object.entries(data.fileMismatches)) {
    console.log(`File ${fileName} needs update. New hash: ${info.expectedHash}, Size: ${info.fileSize} bytes`);

    // Add to download queue
    downloadQueue.push({
      fileName,
      expectedHash: info.expectedHash,
      fileSize: info.fileSize,
      bytesReceived: 0
    });
  }
}
```

### Step 3: Progressive Download

Request file chunks with the `downloads` parameter:

```javascript
// In your next request
const response = await fetch('/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    environment: 'production',
    encrypted: '...',
    nonce: '...',
    auth: '...',
    worldInstanceId: '...',
    commands: { /* your commands */ },
    downloads: {
      'assets/map.dat': {
        hash: expectedHash,
        bytesReceived: 1048576  // Continue from where we left off
      }
    }
  })
});

const data = await response.json();
```

### Step 4: Process Downloaded Chunks

```javascript
if (data.fileDownloads) {
  for (const [fileName, downloadInfo] of Object.entries(data.fileDownloads)) {
    if (downloadInfo.error) {
      console.error(`Error downloading ${fileName}: ${downloadInfo.error}`);
      continue;
    }

    // Decode base64 chunk
    const chunkData = atob(downloadInfo.chunk);

    // Append to file buffer
    fileBuffers[fileName] = fileBuffers[fileName] || new Uint8Array(downloadInfo.fileSize);
    const chunkBytes = new Uint8Array(chunkData.length);
    for (let i = 0; i < chunkData.length; i++) {
      chunkBytes[i] = chunkData.charCodeAt(i);
    }
    fileBuffers[fileName].set(chunkBytes, downloadInfo.offset);

    console.log(`Downloaded ${downloadInfo.bytesInChunk} bytes of ${fileName}. ` +
                `${downloadInfo.remainingBytes} bytes remaining.`);

    if (downloadInfo.complete) {
      // Verify hash
      const actualHash = await sha256(fileBuffers[fileName]);
      if (actualHash === downloadInfo.hash) {
        console.log(`Successfully downloaded ${fileName}`);
        saveFile(fileName, fileBuffers[fileName]);
      } else {
        console.error(`Hash mismatch for ${fileName}! Download corrupted.`);
      }
    } else {
      // Queue next chunk
      downloadQueue.push({
        fileName,
        hash: downloadInfo.hash,
        bytesReceived: downloadInfo.offset + downloadInfo.bytesInChunk
      });
    }
  }
}
```

## Bandwidth Management

### Response Size Limits

- **Maximum Response Size**: 10 MB (10,485,760 bytes)
- **File Download Allocation**: 90% of max response size (9,437,184 bytes)
- **Multiple Files**: Files are processed in alphabetical order until bandwidth is exhausted

### Example Scenarios

**Scenario 1: Single Large File**
- File size: 50 MB
- First request: Downloads ~9 MB (chunk 1)
- Second request: Downloads ~9 MB (chunk 2)
- Continue until complete (~6 requests total)

**Scenario 2: Multiple Small Files**
- Files: A.dat (2 MB), B.dat (3 MB), C.dat (5 MB)
- Single request: Downloads all three files (total 10 MB)

**Scenario 3: Mixed Sizes**
- Files: config.json (10 KB), map.dat (20 MB), assets.pak (15 MB)
- First request: Downloads config.json + ~9 MB of map.dat
- Second request: Downloads remaining map.dat + part of assets.pak
- Third request: Downloads remaining assets.pak

## Monitoring & Health Checks

### Health Check Endpoint

```bash
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-11-02T12:34:56.789Z",
  "uptime": 3600,
  "services": {
    "cache": { "status": "healthy" },
    "ephemeral": { "status": "healthy" },
    "streams": { "status": "healthy" },
    "database": "connected",
    "fileSync": {
      "status": "healthy",
      "filesTracked": {
        "staging": 12,
        "production": 15
      },
      "lastSyncTime": "2025-11-02T12:34:00.000Z",
      "totalDownloads": 27
    }
  }
}
```

### File Sync Stats Endpoint

```bash
GET /stats/file-sync
```

**Response:**
```json
{
  "isAuthorized": true,
  "syncIntervalMs": 60000,
  "filesTracked": {
    "staging": 12,
    "production": 15
  },
  "totalDownloads": 27,
  "totalBytesDownloaded": 104857600,
  "lastSyncTime": "2025-11-02T12:34:00.000Z",
  "stagingFiles": [
    {
      "fileName": "config.json",
      "fileSize": 2048,
      "hash": "a1b2c3d4e5f6...",
      "versionId": "4_z27c88f1d182b7503c0f03ec521f_f1175b2d5a89f6f6d_d20251102_m123400_c002_v0001015_t0058"
    }
  ],
  "productionFiles": [
    {
      "fileName": "config.json",
      "fileSize": 2048,
      "hash": "b2c3d4e5f6a7...",
      "versionId": "4_z27c88f1d182b7503c0f03ec521f_f1175b2d5a89f6f6e_d20251102_m120000_c002_v0001016_t0058"
    }
  ]
}
```

## Background Sync Behavior

### Automatic Updates

The server automatically syncs files from Backblaze B2 in the background:

1. **Initial Sync**: On startup, downloads all files from both staging and production buckets
2. **Periodic Sync**: Every 60 seconds (configurable), checks for new file versions
3. **Version Detection**: Compares B2 file version IDs with cached versions
4. **Download on Change**: Only downloads files that have changed
5. **Hash Calculation**: Computes SHA256 hash for each file
6. **Cache Update**: Updates in-memory cache with new file data

### Metrics

File sync operations are tracked with metrics:
- `file_sync` - Sync operation duration
- `file_download` - Individual file download duration
- `file_sync.mismatches` - Number of hash mismatches detected
- `file_sync.bytes_sent` - Bytes sent to clients

## Security Considerations

### Hash Verification

- All files use SHA256 hashing for integrity verification
- Clients should always verify downloaded file hashes match expected values
- Hash mismatches indicate network corruption or server-side file changes

### Access Control

- File sync respects existing authentication (NaCl encryption + nonce validation)
- Files are isolated by environment (staging vs production)
- No directory traversal - only files in the configured B2 buckets are accessible

### Rate Limiting

- File downloads are subject to the same rate limiting as other API requests
- Bandwidth is limited to prevent response size explosion
- Consider implementing client-side throttling for large file sets

## Troubleshooting

### File Sync Not Working

1. **Check Configuration**: Verify all Backblaze environment variables are set
2. **Check Logs**: Look for "Backblaze file manager initialized successfully" on startup
3. **Verify Credentials**: Ensure B2 API keys have read access to the buckets
4. **Check Health**: Call `/health` to see file sync status

### Files Not Updating

1. **Check Sync Interval**: Default is 60 seconds between syncs
2. **Verify B2 Bucket**: Ensure files are uploaded to the correct bucket
3. **Check Logs**: Look for sync errors in server logs
4. **Manual Trigger**: Restart the server to force a full sync

### Hash Mismatches

1. **Version Mismatch**: Server may have updated the file since client last checked
2. **Corrupted Cache**: Try restarting the server to refresh the cache
3. **B2 Consistency**: B2 may have eventual consistency issues (rare)

### Download Failures

1. **Bandwidth Exceeded**: File may be too large for single response - implement progressive download
2. **Invalid Hash**: Client may be requesting an old version
3. **File Deleted**: File may have been removed from B2

## Example Client Implementation (Pseudo-code)

```javascript
class FileSync {
  constructor() {
    this.localFiles = new Map(); // fileName -> { hash, buffer }
    this.downloadQueue = [];
  }

  async syncFiles() {
    // Step 1: Get current file hashes
    const fileHashes = {};
    for (const [fileName, fileInfo] of this.localFiles.entries()) {
      fileHashes[fileName] = fileInfo.hash;
    }

    // Step 2: Prepare download requests for files in queue
    const downloads = {};
    for (const download of this.downloadQueue) {
      downloads[download.fileName] = {
        hash: download.hash,
        bytesReceived: download.bytesReceived
      };
    }

    // Step 3: Make API request
    const response = await this.apiCall({
      environment: 'production',
      files: fileHashes,
      downloads: downloads
    });

    // Step 4: Handle mismatches
    if (response.fileMismatches) {
      for (const [fileName, info] of Object.entries(response.fileMismatches)) {
        console.log(`File ${fileName} needs update`);
        this.downloadQueue.push({
          fileName,
          hash: info.expectedHash,
          fileSize: info.fileSize,
          bytesReceived: 0,
          buffer: new Uint8Array(info.fileSize)
        });
      }
    }

    // Step 5: Process downloads
    if (response.fileDownloads) {
      this.downloadQueue = this.downloadQueue.filter(item => {
        const download = response.fileDownloads[item.fileName];
        if (!download) return true; // Keep in queue

        if (download.error) {
          console.error(`Download error for ${item.fileName}: ${download.error}`);
          return false; // Remove from queue
        }

        // Decode and append chunk
        const chunk = base64Decode(download.chunk);
        item.buffer.set(chunk, download.offset);
        item.bytesReceived = download.offset + download.bytesInChunk;

        if (download.complete) {
          // Verify and save
          const actualHash = sha256(item.buffer);
          if (actualHash === download.hash) {
            this.localFiles.set(item.fileName, {
              hash: download.hash,
              buffer: item.buffer
            });
            console.log(`✓ Downloaded ${item.fileName}`);
          } else {
            console.error(`✗ Hash mismatch for ${item.fileName}`);
          }
          return false; // Remove from queue
        }

        return true; // Keep in queue for next chunk
      });
    }

    // Continue downloading if queue not empty
    if (this.downloadQueue.length > 0) {
      setTimeout(() => this.syncFiles(), 100);
    }
  }
}
```

## Performance Recommendations

### For Clients

1. **Batch Requests**: Combine file sync with regular command processing
2. **Prioritize Downloads**: Download critical files first
3. **Cache Locally**: Store files locally to reduce sync frequency
4. **Verify Once**: Only verify hash after complete download, not per chunk

### For Server Operators

1. **Adjust Sync Interval**: Increase `FILE_SYNC_INTERVAL_MS` if files rarely change
2. **Monitor Metrics**: Use `/metrics` endpoint to track file sync performance
3. **B2 Costs**: Be aware that each sync triggers B2 API calls (list + download)
4. **Memory Usage**: In-memory cache holds all files - monitor RAM usage

## API Version

This file sync API is available starting from version **1.0.0** of MSW Backend.

## Support

For issues or questions, please check:
- Server logs for detailed error messages
- `/health` endpoint for service status
- `/stats/file-sync` endpoint for sync statistics
