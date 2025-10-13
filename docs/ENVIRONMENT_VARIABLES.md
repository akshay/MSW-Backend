# Environment Variables Reference

Complete reference for all environment variables used in the MSW Backend.

## Required Variables

These variables **must** be set for the application to function:

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL/CockroachDB connection string | `postgresql://user:pass@localhost:5432/msw_backend` |

### Redis

| Variable | Description | Example |
|----------|-------------|---------|
| `CACHE_REDIS_URL` | Redis URL for cache storage | `redis://localhost:6379` |
| `EPHEMERAL_REDIS_URL` | Redis URL for ephemeral entities | `redis://localhost:6379` |
| `STREAM_REDIS_URL` | Redis URL for message streams | `redis://localhost:6379` |

**Note**: All three can point to the same Redis instance, or separate instances for better isolation.

### Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `SENDER_PUBLIC_KEY` | Base64-encoded NaCl public key | `==...` |
| `RECIPIENT_PRIVATE_KEY` | Base64-encoded NaCl private key | `=...` |

## Optional Variables

These variables have sensible defaults but can be customized:

### Server Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `PORT` | HTTP server port | `3000` | `8080` |
| `NODE_ENV` | Environment mode | `development` | `production` |

### Rate Limiting

| Variable | Description | Default | Example | Implementation |
|----------|-------------|---------|---------|----------------|
| `RATE_LIMIT_WINDOW_MS` | Rate limit time window (milliseconds) | `60000` (1 minute) | `30000` (30 seconds) | [rateLimiter.js:15](middleware/rateLimiter.js:15) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` | `200` | [rateLimiter.js:16](middleware/rateLimiter.js:16) |

**How it works**:
- Requests are counted within sliding time windows
- Limits apply per IP address AND per worldInstanceId
- Both per-minute and per-hour limits are automatically calculated
- Example: `RATE_LIMIT_WINDOW_MS=60000` and `RATE_LIMIT_MAX_REQUESTS=100` means 100 requests per minute

### Cache Configuration

| Variable | Description | Default | Example | Implementation |
|----------|-------------|---------|---------|----------------|
| `CACHE_TTL_SECONDS` | Default cache TTL (seconds) | `300` (5 minutes) | `600` (10 minutes) | [HybridCacheManager.js:11](util/HybridCacheManager.js:11), [config.js:43](config.js:43) |
| `CACHE_MAX_SIZE` | Maximum cache entries | `10000` | `50000` | [HybridCacheManager.js:12](util/HybridCacheManager.js:12), [config.js:44](config.js:44) |

**How it works**:
- `CACHE_TTL_SECONDS`: Controls how long items stay in both memory and Redis cache
- `CACHE_MAX_SIZE`: Limits memory cache size (prevents memory overflow)
- When max size is reached, oldest entries are evicted (LRU)
- Redis cache has its own memory limits configured separately

## Environment Variable Usage

### Loading Variables

All variables are automatically loaded using dotenv:

```javascript
// server.js
import 'dotenv/config';

// scripts/benchmark.js
import 'dotenv/config';
```

### Setup

1. Copy example file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your values

3. Start server (automatically loads `.env`):
   ```bash
   npm start
   ```

## Configuration Examples

### Development Environment

```env
# .env (development)
PORT=3000
NODE_ENV=development

DATABASE_URL=postgresql://localhost:5432/msw_dev
CACHE_REDIS_URL=redis://localhost:6379
EPHEMERAL_REDIS_URL=redis://localhost:6379
STREAM_REDIS_URL=redis://localhost:6379

# Relaxed limits for development
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=1000

# Smaller cache for development
CACHE_TTL_SECONDS=300
CACHE_MAX_SIZE=5000
```

### Production Environment

```env
# .env (production)
PORT=3000
NODE_ENV=production

DATABASE_URL=postgresql://prod-host:5432/msw_prod?ssl=true
CACHE_REDIS_URL=redis://cache-prod:6379
EPHEMERAL_REDIS_URL=redis://ephemeral-prod:6379
STREAM_REDIS_URL=redis://stream-prod:6379

# Strict limits for production
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Larger cache for production
CACHE_TTL_SECONDS=600
CACHE_MAX_SIZE=100000
```

### High-Traffic Environment

```env
# .env (high-traffic)
PORT=3000
NODE_ENV=production

# Separate Redis instances for isolation
CACHE_REDIS_URL=redis://cache-cluster:6379
EPHEMERAL_REDIS_URL=redis://ephemeral-cluster:6379
STREAM_REDIS_URL=redis://stream-cluster:6379

# Aggressive rate limiting
RATE_LIMIT_WINDOW_MS=30000
RATE_LIMIT_MAX_REQUESTS=50

# Very large cache
CACHE_TTL_SECONDS=900
CACHE_MAX_SIZE=500000
```

## Tuning Guidelines

### Rate Limiting

**Conservative** (for public APIs):
```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

**Moderate** (for authenticated APIs):
```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=500
```

**Relaxed** (for internal services):
```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=5000
```

### Cache Settings

**Memory-Constrained**:
```env
CACHE_TTL_SECONDS=300
CACHE_MAX_SIZE=5000
```

**Balanced**:
```env
CACHE_TTL_SECONDS=600
CACHE_MAX_SIZE=50000
```

**High-Performance**:
```env
CACHE_TTL_SECONDS=900
CACHE_MAX_SIZE=500000
```

**Cache Hit Optimization**:
```env
CACHE_TTL_SECONDS=1800  # 30 minutes
CACHE_MAX_SIZE=1000000  # 1 million entries
```

## Monitoring

### Startup Logs

When the server starts, you'll see configuration confirmation:

```
Rate limiter configured: 100 requests per 60s window
Cache manager configured: TTL=300s, MaxSize=10000
```

### Checking Current Configuration

View current settings:
```bash
# In development
cat .env | grep -E 'RATE_LIMIT|CACHE'

# In production (don't expose .env!)
node -e "console.log('Rate Limit:', process.env.RATE_LIMIT_MAX_REQUESTS)"
```

## Troubleshooting

### Rate Limiting Issues

**Problem**: Legitimate requests being blocked

**Solution**: Increase limits
```env
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=500  # Increased from 100
```

**Problem**: Server under attack

**Solution**: Decrease limits
```env
RATE_LIMIT_WINDOW_MS=30000   # Shorter window
RATE_LIMIT_MAX_REQUESTS=50   # Stricter limit
```

### Cache Issues

**Problem**: High memory usage

**Solution**: Reduce cache size
```env
CACHE_MAX_SIZE=5000          # Reduced from 10000
CACHE_TTL_SECONDS=180        # Shorter TTL (3 minutes)
```

**Problem**: Low cache hit rate

**Solution**: Increase cache parameters
```env
CACHE_MAX_SIZE=100000        # More entries
CACHE_TTL_SECONDS=900        # Longer TTL (15 minutes)
```

**Problem**: Stale data in cache

**Solution**: Reduce TTL
```env
CACHE_TTL_SECONDS=60         # Shorter TTL (1 minute)
```

## Best Practices

### Security

1. **Never commit `.env` files** - Already in `.gitignore`
2. **Use different keys per environment** - Generate unique keys for dev/staging/prod
3. **Rotate keys periodically** - Update authentication keys regularly
4. **Use strong passwords** - For database and Redis connections

### Performance

1. **Tune for your workload**:
   - High read load → Increase `CACHE_MAX_SIZE` and `CACHE_TTL_SECONDS`
   - High write load → Decrease `CACHE_TTL_SECONDS`
   - Memory limited → Decrease `CACHE_MAX_SIZE`

2. **Monitor and adjust**:
   - Watch cache hit rates
   - Monitor rate limit rejections
   - Adjust based on actual traffic patterns

3. **Separate Redis instances** for production:
   ```env
   CACHE_REDIS_URL=redis://cache-server:6379
   EPHEMERAL_REDIS_URL=redis://ephemeral-server:6379
   STREAM_REDIS_URL=redis://stream-server:6379
   ```

### Deployment

1. **Use environment-specific configs**:
   - `.env.development`
   - `.env.staging`
   - `.env.production`

2. **Use secrets management** in production:
   - AWS Secrets Manager
   - HashiCorp Vault
   - Kubernetes Secrets

3. **Validate on startup**:
   - Server logs show configured values
   - Check logs for configuration issues

## Related Documentation

- [SETUP.md](SETUP.md) - Complete setup guide
- [.env.example](.env.example) - Template with all variables
- [middleware/rateLimiter.js](middleware/rateLimiter.js) - Rate limiter implementation
- [util/HybridCacheManager.js](util/HybridCacheManager.js) - Cache manager implementation
- [config.js](config.js) - Main configuration file
