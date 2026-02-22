# Rate Limiting

## Overview

The MSW Backend implements comprehensive rate limiting to protect the API from abuse and ensure fair resource allocation. Rate limits are enforced on both **World Instance IDs** and **IP addresses**.

## Rate Limit Configuration

### Limits

Both World Instance IDs and IP addresses are subject to the following limits:

- **200 requests per minute**
- **6000 requests per hour**

These limits are enforced using a **sliding window algorithm** with Redis for distributed rate limiting.

### Implementation Details

- **Algorithm**: Sliding window using Redis sorted sets
- **Storage**: Redis (cacheRedis instance)
- **Middleware**: Express middleware integrated into the request pipeline
- **Validation**: Input validation and sanitization for all identifiers

## How It Works

### 1. Request Flow

1. Client makes a request to the API (e.g., `/cloudrun`)
2. Rate limiter extracts:
   - Client IP address (from `req.ip`, `x-forwarded-for`, or `x-real-ip` headers)
   - World Instance ID (from `req.body.worldInstanceId`)
3. Both identifiers are validated and sanitized
4. Four rate limit checks are performed in parallel:
   - IP address - minute window
   - IP address - hour window
   - World Instance ID - minute window
   - World Instance ID - hour window
5. If any limit is exceeded, request is rejected with 429 status
6. If all limits pass, request proceeds with rate limit headers added

### 2. Sliding Window Algorithm

The rate limiter uses Redis sorted sets to implement a sliding window:

```javascript
// Pseudo-code
1. Remove expired entries (older than window)
2. Count remaining entries in window
3. If count < limit:
   - Add current request to sorted set (with timestamp as score)
   - Allow request
4. Else:
   - Reject request with 429 status
```

### 3. Redis Key Structure

Rate limit data is stored in Redis with the following key patterns:

- IP minute limit: `ratelimit:ip:{IP_ADDRESS}:min`
- IP hour limit: `ratelimit:ip:{IP_ADDRESS}:hour`
- World Instance minute limit: `ratelimit:world:{WORLD_INSTANCE_ID}:min`
- World Instance hour limit: `ratelimit:world:{WORLD_INSTANCE_ID}:hour`

Each key contains a sorted set where:
- **Score**: Timestamp in milliseconds
- **Member**: Unique identifier for each request (`{timestamp}-{random}`)

## Response Headers

### Success (200/201 responses)

When a request is allowed, the following headers are included:

```
X-RateLimit-Limit: 200
X-RateLimit-Remaining: 187
X-RateLimit-Reset: 2025-10-08T15:32:45.123Z
```

- `X-RateLimit-Limit`: Maximum requests allowed per minute
- `X-RateLimit-Remaining`: Number of requests remaining in current window
- `X-RateLimit-Reset`: ISO 8601 timestamp when the limit resets

### Rate Limit Exceeded (429 response)

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded for IP",
  "limit": 200,
  "window": "minute",
  "retryAfter": 45,
  "resetAt": "2025-10-08T15:32:45.123Z"
}
```

- `error`: Error type
- `message`: Human-readable description (indicates whether IP or World Instance limit was hit)
- `limit`: The limit that was exceeded
- `window`: Time window ("minute" or "hour")
- `retryAfter`: Seconds until limit resets
- `resetAt`: ISO 8601 timestamp when limit resets

## Input Validation

All identifiers are validated and sanitized to prevent injection attacks:

### World Instance ID Validation

- Must be a string
- Only alphanumeric characters, hyphens, and underscores allowed
- Length: 1-128 characters
- Example valid IDs: `world-123`, `instance_abc`, `world-us-east-1`

### IP Address Validation

- Must be a valid IPv4 or IPv6 address
- IPv4: Standard dotted decimal notation (e.g., `192.168.1.1`)
- IPv6: Standard hexadecimal notation (e.g., `2001:0db8::1`)
- Special value: `unknown` (when IP cannot be determined)

## Error Handling

### Invalid World Instance ID (400)

```json
{
  "error": "Bad Request",
  "message": "Invalid worldInstanceId: Only alphanumeric characters, hyphens, and underscores allowed."
}
```

### Missing World Instance ID for /cloudrun (400)

```json
{
  "error": "Bad Request",
  "message": "worldInstanceId is required"
}
```

### Invalid IP Address (400)

```json
{
  "error": "Bad Request",
  "message": "Invalid IP address: Invalid IP address format: 999.999.999.999"
}
```

## Exemptions

The following endpoints are **exempt** from rate limiting:

- `/health` - Health check endpoint

## Fail-Safe Behavior

The rate limiter is designed to **fail open** for reliability:

- If Redis is unavailable, requests are allowed (logged as error)
- If rate limit check fails due to other errors, requests are allowed
- This ensures API availability even when rate limiting infrastructure has issues

## Configuration

Rate limits are configured in `/middleware/rateLimiter.js`:

```javascript
this.limits = {
  perMinute: 200,
  perHour: 6000
};

this.windows = {
  minute: 60,      // 60 seconds
  hour: 3600       // 3600 seconds
};
```

To modify limits, update these values and restart the server.

## Monitoring

### Key Metrics to Monitor

1. **Rate limit hits**: Number of 429 responses
2. **Redis performance**: Latency of rate limit checks
3. **Top rate-limited IPs/instances**: Identify potential abuse
4. **Fail-open events**: Track when Redis is unavailable

### Redis Commands for Debugging

```bash
# View all rate limit keys
redis-cli KEYS "ratelimit:*"

# Check specific IP's minute limit
redis-cli ZCARD "ratelimit:ip:192.168.1.1:min"

# View requests in window for a world instance
redis-cli ZRANGE "ratelimit:world:instance-123:hour" 0 -1 WITHSCORES

# Clear rate limits for testing
redis-cli DEL $(redis-cli KEYS "ratelimit:*")
```

## Testing

### Manual Testing

```bash
# Test rate limit for IP
for i in {1..201}; do
  curl -X POST http://localhost:3000/cloudrun \
    -H "Content-Type: application/json" \
    -d '{"worldInstanceId": "test-world", "encrypted": "...", "nonce": "...", "auth": "...", "commands": []}'
done

# Test rate limit for World Instance ID (different IPs)
for i in {1..201}; do
  curl -X POST http://localhost:3000/cloudrun \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 192.168.1.$((i % 255))" \
    -d '{"worldInstanceId": "test-world", "encrypted": "...", "nonce": "...", "auth": "...", "commands": []}'
done
```

### Automated Tests

Rate limiter tests are located in `/tests/rateLimiter.test.js`. Run with:

```bash
npm test -- rateLimiter.test.js
```

## Best Practices

1. **Client Implementation**:
   - Respect `Retry-After` header when receiving 429 responses
   - Implement exponential backoff for retries
   - Monitor rate limit headers to avoid hitting limits

2. **Server Configuration**:
   - Ensure Redis has sufficient memory for rate limit data
   - Monitor Redis performance and connection health
   - Consider increasing limits for legitimate high-volume users (requires code change)

3. **Security**:
   - Rate limiting is one layer of defense - combine with authentication, input validation, and monitoring
   - Log rate limit violations for security analysis
   - Consider IP-based blocking for persistent abusers

## Troubleshooting

### Issue: Legitimate traffic being rate limited

**Solution**:
- Review rate limit metrics to identify patterns
- Consider adjusting limits if legitimate use case requires higher throughput
- Ensure clients are properly implementing retry logic

### Issue: Rate limiter not working

**Symptoms**: All requests passing through even when exceeding limits

**Checks**:
1. Verify Redis connection: `redis-cli PING`
2. Check rate limiter is loaded: grep for `rateLimiter.middleware()` in server.js
3. Confirm middleware order (must be after body parsers)
4. Check logs for rate limiter errors

### Issue: Redis memory issues

**Solution**:
- Rate limit keys auto-expire (60s for minute, 3600s for hour)
- If memory pressure exists, consider shorter windows or lower limits
- Monitor Redis memory usage: `redis-cli INFO memory`
