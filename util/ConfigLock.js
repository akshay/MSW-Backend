import { ConfigKeyGenerator } from './ConfigKeyGenerator.js';

export class ConfigLock {
  constructor(redis) {
    this.redis = redis;
  }

  async acquirePublishLock(environment, timeoutSeconds = 60, options = {}) {
    const { maxRetries = 5, retryDelayMs = 250 } = options;
    const keys = new ConfigKeyGenerator(environment);
    const lockKey = keys.publishLock();
    const lockValue = `${process.pid}-${Date.now()}-${Math.random()}`;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.redis.set(lockKey, lockValue, 'NX', 'EX', timeoutSeconds);
      if (result === 'OK') {
        return { acquired: true, value: lockValue, key: lockKey };
      }

      if (attempt < maxRetries) {
        const delay = retryDelayMs * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return { acquired: false, value: null, key: lockKey };
  }

  async releasePublishLock(environment, lockValue) {
    if (!lockValue) {
      return false;
    }

    const keys = new ConfigKeyGenerator(environment);
    const lockKey = keys.publishLock();
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(script, 1, lockKey, lockValue);
    return result === 1;
  }
}
