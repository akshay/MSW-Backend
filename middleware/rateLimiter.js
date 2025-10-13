// middleware/rateLimiter.js
import { cacheRedis } from '../config.js';
import { InputValidator } from '../util/InputValidator.js';

/**
 * Rate Limiter Middleware
 * Implements sliding window rate limiting for both worldInstanceId and IP address
 * Configurable via environment variables:
 * - RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 60000 = 1 minute)
 * - RATE_LIMIT_MAX_REQUESTS: Max requests per window (default: 100)
 */
export class RateLimiter {
  constructor() {
    // Read from environment variables with defaults
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000; // Default: 1 minute
    const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100; // Default: 100 requests

    this.windowSeconds = Math.floor(windowMs / 1000);
    this.maxRequests = maxRequests;

    // Legacy support for per-minute and per-hour limits
    // These are now derived from the main configuration
    this.limits = {
      perMinute: maxRequests,
      perHour: maxRequests * 60 // Scale up for hour if using minute window
    };

    this.windows = {
      minute: this.windowSeconds,
      hour: this.windowSeconds * 60
    };

    console.log(`Rate limiter configured: ${maxRequests} requests per ${this.windowSeconds}s window`);
  }

  /**
   * Extract client IP from request
   * Handles various proxy scenarios
   */
  getClientIp(req) {
    return req.ip ||
           req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           'unknown';
  }

  /**
   * Check rate limit using sliding window algorithm
   * @param {string} key - Rate limit key (e.g., 'ip:127.0.0.1' or 'world:instance123')
   * @param {number} limit - Maximum requests allowed
   * @param {number} windowSeconds - Time window in seconds
   * @returns {Object} { allowed: boolean, remaining: number, resetAt: number }
   */
  async checkLimit(key, limit, windowSeconds) {
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);
    const redisKey = `ratelimit:${key}`;

    try {
      // Use Redis sorted set for sliding window
      const pipeline = cacheRedis.pipeline();

      // Remove expired entries
      pipeline.zremrangebyscore(redisKey, '-inf', windowStart);

      // Count requests in current window
      pipeline.zcard(redisKey);

      // Add current request with score as timestamp
      pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);

      // Set expiry on the key
      pipeline.expire(redisKey, windowSeconds);

      const results = await pipeline.exec();

      // Extract count (index 1 result)
      const count = results[1][1];

      // Check if limit exceeded
      const allowed = count < limit;
      const remaining = Math.max(0, limit - count - 1);
      const resetAt = now + (windowSeconds * 1000);

      return {
        allowed,
        remaining,
        resetAt,
        current: count
      };
    } catch (error) {
      console.error(`Rate limit check failed for key ${key}:`, error);
      // Fail open - allow request if Redis is down
      return {
        allowed: true,
        remaining: limit,
        resetAt: now + (windowSeconds * 1000),
        current: 0
      };
    }
  }

  /**
   * Rate limiting middleware
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // Extract identifiers
        const clientIp = this.getClientIp(req);
        const worldInstanceId = req.body?.worldInstanceId;

        // Skip rate limiting for health checks
        if (req.path === '/health') {
          return next();
        }

        // Validate and sanitize IP address
        let sanitizedIp;
        try {
          sanitizedIp = InputValidator.sanitizeIpAddress(clientIp);
        } catch (error) {
          return res.status(400).json({
            error: 'Bad Request',
            message: `Invalid IP address: ${error.message}`
          });
        }

        // Check if worldInstanceId is present (required for /process endpoint)
        if (!worldInstanceId && req.path === '/process') {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'worldInstanceId is required'
          });
        }

        // Validate and sanitize worldInstanceId if present
        let sanitizedWorldInstanceId;
        if (worldInstanceId) {
          try {
            sanitizedWorldInstanceId = InputValidator.sanitizeWorldInstanceId(worldInstanceId);
          } catch (error) {
            return res.status(400).json({
              error: 'Bad Request',
              message: `Invalid worldInstanceId: ${error.message}`
            });
          }
        }

        const checks = [];

        // Check IP rate limits
        checks.push(
          this.checkLimit(`ip:${sanitizedIp}:min`, this.limits.perMinute, this.windows.minute),
          this.checkLimit(`ip:${sanitizedIp}:hour`, this.limits.perHour, this.windows.hour)
        );

        // Check worldInstanceId rate limits if present
        if (sanitizedWorldInstanceId) {
          checks.push(
            this.checkLimit(`world:${sanitizedWorldInstanceId}:min`, this.limits.perMinute, this.windows.minute),
            this.checkLimit(`world:${sanitizedWorldInstanceId}:hour`, this.limits.perHour, this.windows.hour)
          );
        }

        // Execute all checks in parallel
        const results = await Promise.all(checks);

        // Find the most restrictive limit
        const violated = results.find(r => !r.allowed);

        if (violated) {
          // Determine which limit was violated
          const violationType = results.indexOf(violated) < 2 ? 'IP' : 'World Instance';
          const windowType = results.indexOf(violated) % 2 === 0 ? 'minute' : 'hour';
          const limit = windowType === 'minute' ? this.limits.perMinute : this.limits.perHour;

          return res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit exceeded for ${violationType}`,
            limit: limit,
            window: windowType,
            retryAfter: Math.ceil((violated.resetAt - Date.now()) / 1000),
            resetAt: new Date(violated.resetAt).toISOString()
          });
        }

        // All checks passed - add rate limit headers
        const mostRestrictive = results.reduce((min, r) =>
          r.remaining < min.remaining ? r : min
        );

        res.setHeader('X-RateLimit-Limit', this.limits.perMinute);
        res.setHeader('X-RateLimit-Remaining', mostRestrictive.remaining);
        res.setHeader('X-RateLimit-Reset', new Date(mostRestrictive.resetAt).toISOString());

        next();
      } catch (error) {
        console.error('Rate limiter middleware error:', error);
        // Fail open - allow request if middleware fails
        next();
      }
    };
  }
}

export const rateLimiter = new RateLimiter();
