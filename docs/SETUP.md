# Setup Guide

Quick setup guide for the MSW Backend with dotenv configuration.

## Prerequisites

- Node.js 18+ with ES modules support
- PostgreSQL or CockroachDB database
- Redis server
- npm or yarn package manager

## Step-by-Step Setup

### 1. Install Dependencies

```bash
npm install
```

This will install all required packages including:
- express, cors, helmet (server)
- @prisma/client (database)
- ioredis (Redis client)
- tweetnacl (encryption)
- dotenv (environment variables)

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your actual configuration:

```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Database - Update with your database credentials
DATABASE_URL=postgresql://user:password@localhost:5432/msw_backend

# Redis - Update with your Redis URLs
CACHE_REDIS_URL=redis://localhost:6379
EPHEMERAL_REDIS_URL=redis://localhost:6379
STREAM_REDIS_URL=redis://localhost:6379

# Authentication Keys - Generate with tweetnacl
SENDER_PUBLIC_KEY=base64_encoded_public_key_here
RECIPIENT_PRIVATE_KEY=base64_encoded_private_key_here

# Rate Limiting (optional)
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Cache Settings (optional)
CACHE_TTL_SECONDS=300
CACHE_MAX_SIZE=10000
```

### 3. Generate Authentication Keys

If you need to generate NaCl keypairs:

Run: `node scripts/generateKeys.js`

### 4. Setup Database

#### Create Database

```bash
# PostgreSQL
createdb msw_backend

# Or using psql
psql -c "CREATE DATABASE msw_backend;"
```

#### Run Migrations

```bash
# Generate Prisma client
npm run db:generate

# Or use Prisma migrate (if configured)
npm run db:migrate
```

### 5. Verify Redis Connection

Test that Redis is running and accessible:

```bash
# Ping Redis
redis-cli ping
# Should respond: PONG

# Check Redis is listening
redis-cli INFO server
```

If Redis is not running:

```bash
# macOS with Homebrew
brew services start redis

# Linux with systemd
sudo systemctl start redis

# Or run Redis in foreground
redis-server
```

### 6. Start the Server

#### Development Mode (with auto-reload)

```bash
npm run dev
```

#### Production Mode

```bash
npm start
```

The server will start on the configured PORT (default: 3000).

### 7. Verify Setup

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 123.456,
  "services": {
    "cache": { "status": "healthy", ... },
    "ephemeral": { "status": "healthy", ... },
    "streams": { "status": "healthy", ... },
    "database": "connected"
  }
}
```

### 8. Run Benchmark Tests

Verify everything works correctly:

```bash
npm run benchmark
```

This will:
- Create, load, update, and delete 5,000 entities
- Test search and ranking queries
- Test stream operations
- Measure performance

Expected output:
```
✓ PASS Create entities 2341ms 5000/5000 created, 2136 ops/sec
✓ PASS Load entities 1823ms 5000/5000 loaded, 2743 ops/sec
...
✓ ALL TESTS PASSED!
```

## Environment Variables Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/db` |
| `CACHE_REDIS_URL` | Redis URL for cache | `redis://localhost:6379` |
| `EPHEMERAL_REDIS_URL` | Redis URL for ephemeral entities | `redis://localhost:6379` |
| `STREAM_REDIS_URL` | Redis URL for streams | `redis://localhost:6379` |
| `SENDER_PUBLIC_KEY` | Base64 NaCl public key | `dGVzdGtleQ==...` |
| `RECIPIENT_PRIVATE_KEY` | Base64 NaCl private key | `dGVzdGtleQ==...` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit time window | `60000` |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |
| `CACHE_TTL_SECONDS` | Cache TTL in seconds | `300` |
| `CACHE_MAX_SIZE` | Max cache entries | `10000` |

## Troubleshooting

### "Cannot find module 'dotenv'"

```bash
npm install dotenv
```

### "DATABASE_URL is not defined"

Ensure `.env` file exists in project root and contains `DATABASE_URL`.

### "Connection refused" for Redis

Check Redis is running:
```bash
redis-cli ping
```

If not running, start Redis:
```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis
```

### "Authentication failed"

Verify `SENDER_PUBLIC_KEY` and `RECIPIENT_PRIVATE_KEY` are correctly set in `.env` and match your client keys.

### Port Already in Use

Change `PORT` in `.env` or kill the process using the port:
```bash
# Find process
lsof -i :3000

# Kill process
kill -9 <PID>
```

### Prisma Client Errors

Regenerate Prisma client:
```bash
npm run db:generate
```

## Production Deployment

### Environment Setup

1. Set `NODE_ENV=production` in `.env`
2. Use production database and Redis URLs
3. Generate production-specific authentication keys
4. Configure rate limiting for production load
5. Set appropriate cache sizes

### Security Checklist

- [ ] Production database with strong password
- [ ] Redis with authentication enabled
- [ ] Unique NaCl keypairs for production
- [ ] Rate limiting configured appropriately
- [ ] Firewall rules for database and Redis
- [ ] HTTPS/TLS for external connections
- [ ] Environment variables secured (not in version control)
- [ ] Logs monitored for suspicious activity

### Performance Tuning

For production load:

```env
# Increase cache sizes
CACHE_MAX_SIZE=100000
CACHE_TTL_SECONDS=600

# Adjust rate limits
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=1000
```

### Monitoring

Monitor these metrics:
- `/health` endpoint status
- Cache hit rates (in logs)
- Database connection pool
- Redis memory usage
- Request latency
- Error rates

### Backup Strategy

Regular backups:
```bash
# PostgreSQL backup
pg_dump msw_backend > backup_$(date +%Y%m%d).sql

# Redis backup
redis-cli SAVE
cp /var/lib/redis/dump.rdb backup_redis_$(date +%Y%m%d).rdb
```

## Next Steps

- Read [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for feature overview
- Review [QUERY_COMMANDS_DOCUMENTATION.md](QUERY_COMMANDS_DOCUMENTATION.md) for API details
- Check [scripts/README.md](scripts/README.md) for benchmark documentation
- Implement client-side integration with authentication

## Support

For issues:
1. Check this setup guide
2. Review troubleshooting section
3. Verify `.env` configuration
4. Run benchmark to test system
5. Check logs for error details
