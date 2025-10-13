// tests/rateLimiter.test.js
import { RateLimiter } from '../util/RateLimiter.js';
import { cacheRedis } from '../config.js';

describe('RateLimiter', () => {
  let rateLimiter;

  beforeEach(async () => {
    rateLimiter = new RateLimiter();
    // Clear all rate limit keys before each test
    const keys = await cacheRedis.keys('ratelimit:*');
    if (keys.length > 0) {
      await cacheRedis.del(...keys);
    }
  });

  afterAll(async () => {
    // Clean up
    const keys = await cacheRedis.keys('ratelimit:*');
    if (keys.length > 0) {
      await cacheRedis.del(...keys);
    }
  });

  describe('getClientIp', () => {
    it('should extract IP from req.ip', () => {
      const req = { ip: '192.168.1.1' };
      expect(rateLimiter.getClientIp(req)).toBe('192.168.1.1');
    });

    it('should extract IP from x-forwarded-for header', () => {
      const req = {
        headers: {
          'x-forwarded-for': '203.0.113.1, 192.168.1.1'
        }
      };
      expect(rateLimiter.getClientIp(req)).toBe('203.0.113.1');
    });

    it('should extract IP from x-real-ip header', () => {
      const req = {
        headers: {
          'x-real-ip': '203.0.113.2'
        }
      };
      expect(rateLimiter.getClientIp(req)).toBe('203.0.113.2');
    });

    it('should return unknown if no IP found', () => {
      const req = { headers: {} };
      expect(rateLimiter.getClientIp(req)).toBe('unknown');
    });
  });

  describe('checkLimit', () => {
    it('should allow requests under the limit', async () => {
      const result = await rateLimiter.checkLimit('test:key1', 10, 60);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeLessThanOrEqual(9);
      expect(result.current).toBe(0);
    });

    it('should block requests over the limit', async () => {
      const limit = 5;
      const key = 'test:key2';

      // Make limit number of requests
      for (let i = 0; i < limit; i++) {
        await rateLimiter.checkLimit(key, limit, 60);
      }

      // Next request should be blocked
      const result = await rateLimiter.checkLimit(key, limit, 60);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should implement sliding window correctly', async () => {
      const key = 'test:sliding';
      const limit = 3;
      const window = 2; // 2 seconds

      // Make 3 requests
      await rateLimiter.checkLimit(key, limit, window);
      await rateLimiter.checkLimit(key, limit, window);
      await rateLimiter.checkLimit(key, limit, window);

      // 4th request should fail
      const blocked = await rateLimiter.checkLimit(key, limit, window);
      expect(blocked.allowed).toBe(false);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 2100));

      // Should allow new requests after window expires
      const allowed = await rateLimiter.checkLimit(key, limit, window);
      expect(allowed.allowed).toBe(true);
    }, 10000); // Increase timeout for this test

    it('should track remaining requests correctly', async () => {
      const key = 'test:remaining';
      const limit = 10;

      const result1 = await rateLimiter.checkLimit(key, limit, 60);
      expect(result1.remaining).toBe(9);

      const result2 = await rateLimiter.checkLimit(key, limit, 60);
      expect(result2.remaining).toBe(8);

      const result3 = await rateLimiter.checkLimit(key, limit, 60);
      expect(result3.remaining).toBe(7);
    });
  });

  describe('middleware', () => {
    let req, res, next;

    beforeEach(() => {
      req = {
        ip: '192.168.1.100',
        path: '/process',
        body: {
          worldInstanceId: 'test-world-123'
        },
        headers: {}
      };

      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      };

      next = jest.fn();
    });

    it('should allow requests under rate limits', async () => {
      const middleware = rateLimiter.middleware();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 200);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
    });

    it('should skip rate limiting for health checks', async () => {
      req.path = '/health';
      const middleware = rateLimiter.middleware();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should require worldInstanceId for /process endpoint', async () => {
      delete req.body.worldInstanceId;
      const middleware = rateLimiter.middleware();
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Bad Request',
        message: 'worldInstanceId is required'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should block requests when IP minute limit exceeded', async () => {
      const middleware = rateLimiter.middleware();

      // Make 200 requests (the limit)
      for (let i = 0; i < 200; i++) {
        await middleware(req, res, next);
        // Reset mocks for next iteration
        res.status.mockClear();
        res.json.mockClear();
        next.mockClear();
      }

      // 201st request should be blocked
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too Many Requests',
          message: expect.stringContaining('IP'),
          limit: 200,
          window: 'minute'
        })
      );
      expect(next).not.toHaveBeenCalled();
    }, 30000); // Increase timeout

    it('should block requests when worldInstanceId minute limit exceeded', async () => {
      const middleware = rateLimiter.middleware();

      // Make 200 requests with same worldInstanceId but different IPs
      for (let i = 0; i < 200; i++) {
        req.ip = `192.168.1.${i % 255}`;
        await middleware(req, res, next);
        res.status.mockClear();
        res.json.mockClear();
        next.mockClear();
      }

      // 201st request should be blocked
      req.ip = '192.168.1.250';
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too Many Requests',
          message: expect.stringContaining('World Instance'),
          limit: 200,
          window: 'minute'
        })
      );
      expect(next).not.toHaveBeenCalled();
    }, 30000); // Increase timeout

    it('should enforce both IP and worldInstanceId limits independently', async () => {
      const middleware = rateLimiter.middleware();

      // Make 200 requests from same IP with different worldInstanceIds
      for (let i = 0; i < 200; i++) {
        req.body.worldInstanceId = `world-${i}`;
        await middleware(req, res, next);
        res.status.mockClear();
        res.json.mockClear();
        next.mockClear();
      }

      // 201st request from same IP should be blocked (IP limit)
      req.body.worldInstanceId = 'world-new';
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too Many Requests',
          message: expect.stringContaining('IP')
        })
      );
    }, 30000); // Increase timeout

    it('should set rate limit headers on successful requests', async () => {
      const middleware = rateLimiter.middleware();
      await middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 200);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
    });

    it('should include retry-after in rate limit response', async () => {
      const middleware = rateLimiter.middleware();

      // Exceed limit
      for (let i = 0; i < 201; i++) {
        await middleware(req, res, next);
        res.status.mockClear();
        res.json.mockClear();
        next.mockClear();
      }

      await middleware(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          retryAfter: expect.any(Number),
          resetAt: expect.any(String)
        })
      );
    }, 30000); // Increase timeout
  });
});
