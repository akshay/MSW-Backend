# MSW Backend - Operations Guide

Backend service for MapleStory Worlds game servers. Handles entity management, real-time streaming, file sync, and audit logging.

## Quick Start

### Docker Deployment (Recommended)

```bash
# Start all services (PostgreSQL, 4 Redis instances, MinIO, App)
npm run docker:up

# View logs
npm run docker:logs

# Stop all services
npm run docker:down
```

**Services exposed:**
- App: `http://localhost:3000`
- MinIO Console: `http://localhost:9001` (msw_access_key / msw_secret_key)
- PostgreSQL: `localhost:5432` (msw / msw_password)
- Redis: `localhost:6379-6382`

### Manual Setup

```bash
npm install
npm run db:generate
npm run db:push
npm start
```

---

## Deployment

### Quick Reference

| Environment | RAM | Command | Platform |
|-------------|-----|---------|----------|
| Staging | 4 GB | `npm run docker:staging` | Old laptop/desktop |
| Production | 8 GB+ | `npm run docker:prod` | Hetzner CCX13 |

**For detailed deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)**

### Cost Comparison

| Option | RAM | Storage | Price | Best For |
|--------|-----|---------|-------|----------|
| Old laptop/desktop | 4 GB+ | varies | €0/mo | Staging |
| Hetzner CPX31 | 8 GB | 160 GB | €14.20/mo | Production |
| Hetzner CCX13 | 8 GB (dedicated) | 160 GB | €23.40/mo | Production |

**For detailed deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)**

---

## Docker Commands

| Command | Description |
|---------|-------------|
| `npm run docker:up` | Start all containers in background |
| `npm run docker:down` | Stop all containers |
| `npm run docker:logs` | Follow container logs |
| `npm run docker:ps` | List running containers |
| `npm run docker:restart` | Restart all containers |
| `npm run docker:build` | Rebuild containers |
| `npm run docker:rebuild` | Clean build and restart |
| `npm run docker:clean` | Remove containers and volumes |

---

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### Required Variables

```bash
# Database
DATABASE_URL=postgresql://msw:msw_password@postgres:5432/msw_backend

# Redis (4 separate instances)
CACHE_REDIS_URL=redis://redis-cache:6379
EPHEMERAL_REDIS_URL=redis://redis-ephemeral:6379
STREAM_REDIS_URL=redis://redis-stream:6379
AUDIT_REDIS_URL=redis://redis-audit:6379

# Authentication Keys
SENDER_PUBLIC_KEY=<base64-encoded-public-key>
RECIPIENT_PRIVATE_KEY=<base64-encoded-private-key>

# S3 Storage (MinIO for local, Backblaze/AWS for production)
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY_ID=msw_access_key
S3_SECRET_ACCESS_KEY=msw_secret_key
```

### Optional Variables

```bash
# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# File Sync
FILE_SYNC_ENABLED=true
FILE_SYNC_INTERVAL_MS=60000

# Backup
BACKUP_ENABLED=true
BACKUP_SCHEDULE="0 */6 * * *"
BACKUP_RETENTION_DAYS=7

# Audit
AUDIT_ENABLED=true
AUDIT_DB_RETENTION_DAYS=30
```

---

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

Returns status of all services: database, Redis instances, file sync.

### Metrics Dashboard

- **Dashboard**: `http://localhost:3000/dashboard`
- **Prometheus**: `http://localhost:3000/metrics/prometheus`
- **JSON API**: `http://localhost:3000/metrics`

### Key Metrics to Monitor

| Metric | Endpoint | Threshold |
|--------|----------|-----------|
| Error rate | `/audit/stats` | < 5% |
| Cache hit rate | `/metrics/summary` | > 80% |
| P95 latency | `/metrics` | < 500ms |
| Stream buffer | `/audit/stats` | < 100,000 |

---

## Audit Logging

### Dashboard

Access the audit log viewer at `/dashboard` (scroll to Audit Logs section).

### API Endpoints

```bash
# Get logs with filters
curl "http://localhost:3000/audit/logs?commandType=load&entityType=PlayerCharacter&limit=50"

# Get breakdown stats
curl "http://localhost:3000/audit/breakdown"

# Get errors
curl "http://localhost:3000/audit/errors"

# Get performance stats
curl "http://localhost:3000/audit/performance"
```

### Filters

- `commandType`: load, save, send, recv, search, rank, top
- `entityType`: PlayerCharacter, Account, Guild, etc.
- `worldInstanceId`: Specific world instance
- `success`: true/false

---

## Backup & Restore

### Automated Backups

Backups run automatically based on `BACKUP_SCHEDULE` (default: every 6 hours).

```bash
# View backup status
curl http://localhost:3001/health

# List backups
curl http://localhost:3000/api/backups/history

# Backup stats
curl http://localhost:3000/api/backups/stats
```

### Manual Backup

```bash
npm run backup:manual
```

### Restore

1. Go to `/dashboard`
2. Find backup in Backup History table
3. Click "Restore"
4. Select restore type (db-only recommended)
5. Confirm timestamp

---

## Database Operations

```bash
# Generate Prisma client (after schema changes)
npm run db:generate

# Push schema to database
npm run db:push

# Run migrations
npm run db:migrate

# Open Prisma Studio
npm run db:studio
```

---

## Storage Operations

### MinIO Console

1. Open `http://<server>:9001`
2. Login: `msw_access_key` / `msw_secret_key`
3. Buckets: `staging`, `production`, `backups`

### File Sync

Files are synced automatically from `configDir` to S3 buckets every 60 seconds.

---

## Scaling

### Vertical Scaling (Single Server)

- Increase Redis memory limits in `docker-compose.yml`
- Adjust `maxmemory` settings per Redis instance
- Increase PostgreSQL resources

### Horizontal Scaling (Multiple Servers)

1. **External PostgreSQL**: Point `DATABASE_URL` to CockroachDB
2. **External Redis**: Update `*_REDIS_URL` to external instances
3. **External S3**: Update `S3_ENDPOINT` to Backblaze/AWS
4. **Remove local services**: Comment out unused services in `docker-compose.yml`

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use external CockroachDB cluster
- [ ] Use managed Redis (or Redis Cluster)
- [ ] Configure S3 (Backblaze/AWS)
- [ ] Set up monitoring/alerting
- [ ] Configure backup schedule
- [ ] Review rate limiting settings
- [ ] Generate new auth keys
- [ ] Setup domain with HTTPS

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
npm run docker:logs

# Check specific service
docker logs msw-backend
docker logs msw-postgres
```

### Database Connection Issues

```bash
# Check PostgreSQL is running
docker logs msw-postgres

# Test connection
docker exec -it msw-postgres psql -U msw -d msw_backend
```

### Redis Connection Issues

```bash
# Test Redis connection
docker exec -it msw-redis-cache redis-cli ping
```

### High Memory Usage

```bash
# Check Redis memory
docker exec -it msw-redis-cache redis-cli info memory

# Check app memory
docker stats msw-backend
```

### Reset Everything

```bash
# Stop and remove all data
npm run docker:clean

# Start fresh
npm run docker:up
```

---

## Common Operations

### Rotate Auth Keys

1. Generate new keypair
2. Update `.env` with new keys
3. Restart: `npm run docker:restart`
4. Update client with new public key

### Clear Redis Cache

```bash
docker exec -it msw-redis-cache redis-cli FLUSHDB
docker exec -it msw-redis-ephemeral redis-cli FLUSHDB
```

### View Recent Errors

```bash
curl http://localhost:3000/audit/errors | jq
```

### Check File Sync Status

```bash
curl http://localhost:3000/stats/file-sync
```

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         MSW Backend                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Express API (port 3000)                                         │
│       │                                                          │
│       ├── Entity Management (load, save, search)                │
│       ├── Real-time Streaming (Redis Streams)                   │
│       ├── File Sync (S3/MinIO)                                  │
│       └── Audit Logging (Redis → PostgreSQL)                    │
│                                                                  │
│  Storage:                                                        │
│       ├── PostgreSQL (entities)                                 │
│       ├── Redis Cache (hot data)                                │
│       ├── Redis Ephemeral (temporary data)                      │
│       ├── Redis Stream (messages)                               │
│       ├── Redis Audit (audit buffer)                            │
│       └── S3/MinIO (files, backups)                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Support

- Health check: `GET /health`
- Metrics: `GET /metrics`
- Dashboard: `GET /dashboard`
- Audit logs: `GET /audit/logs`