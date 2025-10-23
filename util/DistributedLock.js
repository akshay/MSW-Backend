// util/DistributedLock.js
import { config } from '../config.js';
import { metrics } from './MetricsCollector.js';

export class DistributedLock {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * Acquire a distributed lock using Redis SET NX EX
   * @param {string} lockKey - The key name for the lock
   * @param {number} ttl - Time to live in seconds
   * @param {string} lockValue - Unique value for this lock holder
   * @returns {Promise<boolean>} - True if lock was acquired, false otherwise
   */
  async acquire(lockKey, ttl = config.lock.defaultTTL, lockValue = null) {
    const value = lockValue || `${process.pid}-${Date.now()}-${Math.random()}`;

    try {
      // SET key value NX EX ttl
      // NX - Only set if key doesn't exist
      // EX - Set expiry in seconds
      const result = await this.redis.set(lockKey, value, 'NX', 'EX', ttl);

      if (result === 'OK') {
        metrics.recordLockAcquired(lockKey, ttl * 1000);
        return { acquired: true, value };
      }

      metrics.recordLockFailed(lockKey);
      return { acquired: false, value: null };
    } catch (error) {
      console.error('Failed to acquire lock:', lockKey, error);
      metrics.recordLockFailed(lockKey);
      return { acquired: false, value: null };
    }
  }

  /**
   * Release a distributed lock
   * @param {string} lockKey - The key name for the lock
   * @param {string} lockValue - The value that was used to acquire the lock
   * @returns {Promise<boolean>} - True if lock was released, false otherwise
   */
  async release(lockKey, lockValue) {
    try {
      // Use Lua script to ensure atomic check-and-delete
      // Only delete if the value matches (prevents releasing someone else's lock)
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(script, 1, lockKey, lockValue);
      if (result === 1) {
        metrics.recordLockReleased(lockKey);
      }
      return result === 1;
    } catch (error) {
      console.error('Failed to release lock:', lockKey, error);
      return false;
    }
  }

  /**
   * Execute a function with a distributed lock
   * @param {string} lockKey - The key name for the lock
   * @param {Function} fn - The function to execute while holding the lock
   * @param {number} ttl - Time to live in seconds
   * @returns {Promise<any>} - The result of the function
   */
  async withLock(lockKey, fn, ttl = config.lock.defaultTTL) {
    const { acquired, value } = await this.acquire(lockKey, ttl);

    if (!acquired) {
      console.log(`Could not acquire lock: ${lockKey}`);
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.release(lockKey, value);
    }
  }

  /**
   * Try to acquire lock with retries
   * @param {string} lockKey - The key name for the lock
   * @param {number} ttl - Time to live in seconds
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} retryDelay - Delay between retries in milliseconds
   * @returns {Promise<{acquired: boolean, value: string}>}
   */
  async acquireWithRetry(lockKey, ttl = config.lock.defaultTTL, maxRetries = config.lock.maxRetries, retryDelay = config.lock.retryDelayMs) {
    for (let i = 0; i < maxRetries; i++) {
      const result = await this.acquire(lockKey, ttl);

      if (result.acquired) {
        return result;
      }

      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    return { acquired: false, value: null };
  }
}
