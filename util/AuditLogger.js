import { auditRedis, config } from '../config.js';
import { metrics } from './MetricsCollector.js';

const SKIP_COMMANDS = new Set(config.audit.skipCommands || ['emit', 'presence']);

const COMMAND_TYPES = ['load', 'save', 'send', 'recv', 'search', 'rank', 'top'];

export class AuditLogger {
  constructor(options = {}) {
    this.redis = options.redis || auditRedis;
    this.streamKey = options.streamKey || config.audit.streamKey;
    this.maxLen = options.maxStreamLength || config.audit.maxStreamLength;
    this.streamTTL = options.streamTTL || config.audit.streamTTL;
    this.enabled = config.audit.enabled;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized || !this.enabled) return;
    
    try {
      await this.redis.expire(this.streamKey, this.streamTTL);
      this.initialized = true;
    } catch (error) {
      console.error('[AuditLogger] Initialization failed:', error);
    }
  }

  async logCommands(requestContext, commands, results, statusCode = 200) {
    if (!this.enabled) return 0;

    await this.initialize();

    const entries = [];
    const timestamp = new Date().toISOString();

    for (const commandType of COMMAND_TYPES) {
      if (SKIP_COMMANDS.has(commandType)) continue;
      
      const commandList = commands[commandType];
      if (!Array.isArray(commandList) || commandList.length === 0) continue;

      for (const cmd of commandList) {
        const result = this.getResultForCommand(results, commandType, cmd.originalIndex);
        
        entries.push({
          timestamp,
          worldInstanceId: requestContext.worldInstanceId,
          clientIp: requestContext.clientIp,
          environment: requestContext.environment,
          
          commandType,
          commandIndex: cmd.originalIndex ?? 0,
          
          entityType: cmd.entityType || null,
          entityId: cmd.entityId || null,
          worldId: cmd.worldId || null,
          
          inputData: this.extractInputData(cmd),
          outputData: this.extractOutputData(result),
          
          statusCode,
          durationMs: requestContext.durationMs || 0,
          success: this.isSuccess(result),
          errorMessage: this.extractError(result),
          
          method: requestContext.method || 'POST',
          path: requestContext.path || '/cloudrun'
        });
      }
    }

    if (entries.length > 0) {
      await this.writeBatchToStream(entries);
      metrics.recordAuditBatch(entries.length);
    }

    return entries.length;
  }

  async logFailedRequest(requestContext, error, statusCode = 500) {
    if (!this.enabled) return 0;

    await this.initialize();

    const entry = {
      timestamp: new Date().toISOString(),
      worldInstanceId: requestContext.worldInstanceId,
      clientIp: requestContext.clientIp,
      environment: requestContext.environment,
      
      commandType: 'request',
      commandIndex: 0,
      
      entityType: null,
      entityId: null,
      worldId: null,
      
      inputData: null,
      outputData: null,
      
      statusCode,
      durationMs: requestContext.durationMs || 0,
      success: false,
      errorMessage: error?.message || 'Unknown error',
      
      method: requestContext.method || 'POST',
      path: requestContext.path || '/cloudrun'
    };

    await this.writeBatchToStream([entry]);
    metrics.recordAuditBatch(1);

    return 1;
  }

  getResultForCommand(results, commandType, originalIndex) {
    if (!results || typeof results !== 'object') return null;
    
    const typeResults = results[commandType];
    if (!Array.isArray(typeResults)) return null;
    
    return typeResults.find(r => r?.originalIndex === originalIndex);
  }

  extractInputData(cmd) {
    if (!cmd || typeof cmd !== 'object') return null;
    
    const { originalIndex, ...input } = cmd;
    const keys = Object.keys(input);
    
    if (keys.length === 0) return null;
    
    const sanitized = {};
    for (const key of keys) {
      const value = input[key];
      if (value !== undefined) {
        sanitized[key] = this.sanitizeValue(value);
      }
    }
    
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  }

  extractOutputData(result) {
    if (!result) return null;
    
    if (result.result !== undefined) {
      return this.sanitizeValue(result.result);
    }
    
    if (result.success !== undefined || result.error !== undefined) {
      return {
        success: result.success,
        error: result.error
      };
    }
    
    return this.sanitizeValue(result);
  }

  sanitizeValue(value, depth = 0) {
    if (depth > 10) return { _truncated: 'max depth exceeded' };
    
    if (value === null || value === undefined) return value;
    
    if (typeof value !== 'object') return value;
    
    if (Array.isArray(value)) {
      if (value.length > 100) {
        return value.slice(0, 100).map(v => this.sanitizeValue(v, depth + 1));
      }
      return value.map(v => this.sanitizeValue(v, depth + 1));
    }
    
    const keys = Object.keys(value);
    if (keys.length > 50) {
      const sanitized = {};
      keys.slice(0, 50).forEach(k => {
        sanitized[k] = this.sanitizeValue(value[k], depth + 1);
      });
      sanitized._truncated = `${keys.length - 50} more keys`;
      return sanitized;
    }
    
    const sanitized = {};
    for (const key of keys) {
      sanitized[key] = this.sanitizeValue(value[key], depth + 1);
    }
    return sanitized;
  }

  isSuccess(result) {
    if (!result) return true;
    if (result.success === false) return false;
    if (result.error) return false;
    return true;
  }

  extractError(result) {
    if (!result) return null;
    if (result.error) return String(result.error).substring(0, 500);
    if (result.errorMessage) return String(result.errorMessage).substring(0, 500);
    return null;
  }

  async writeBatchToStream(entries) {
    if (entries.length === 0) return;

    const pipeline = this.redis.pipeline();
    
    for (const entry of entries) {
      pipeline.xadd(
        this.streamKey,
        'MAXLEN', '~', this.maxLen,
        '*',
        'data', JSON.stringify(entry)
      );
    }

    await pipeline.exec();
  }

  async getStats() {
    try {
      const info = await this.redis.xinfo('STREAM', this.streamKey);
      return {
        length: info[1],
        firstEntry: info[3],
        lastEntry: info[5],
        groups: info[7]
      };
    } catch (error) {
      if (error.message?.includes('no such key')) {
        return { length: 0, firstEntry: null, lastEntry: null, groups: 0 };
      }
      throw error;
    }
  }
}

export const auditLogger = new AuditLogger();