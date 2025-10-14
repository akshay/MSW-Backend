// src/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, ephemeralRedis, streamRedis } from './config.js';
import { CommandProcessor } from './util/CommandProcessor.js';
import { rateLimiter } from './util/RateLimiter.js';

const app = express();
const commandProcessor = new CommandProcessor();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting middleware - must be after body parsers
app.use(rateLimiter.middleware());

// Health check endpoint
// src/server.js - Updated health check
app.get('/health', async (req, res) => {
  try {
    const [cacheHealth, ephemeralHealth, streamHealth] = await Promise.all([
      commandProcessor.cache.healthCheck(),
      checkRedisHealth(ephemeralRedis, 'ephemeral'),
      checkRedisHealth(streamRedis, 'streams')
    ]);

    const overallHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        cache: cacheHealth,
        ephemeral: ephemeralHealth,
        streams: streamHealth,
        database: 'connected' // Prisma doesn't have a simple ping
      }
    };

    const allHealthy = [cacheHealth, ephemeralHealth, streamHealth]
      .every(service => service.status === 'healthy');

    res.status(allHealthy ? 200 : 503).json(overallHealth);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

async function checkRedisHealth(redis, serviceName) {
  try {
    const ping = await redis.ping();
    return {
      status: 'healthy',
      service: serviceName,
      response: ping
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      service: serviceName,
      error: error.message
    };
  }
}

// Main batch processing endpoint
app.post('/process', async (req, res) => {
  const startTime = performance.now();
  
  try {
    // Process commands
    const results = await commandProcessor.processCommands(req.body);
    
    const processingTime = performance.now() - startTime;
    
    res.json({ 
      results,
      meta: {
        commandCount: commands.length,
        processingTimeMs: Math.round(processingTime),
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    
    const processingTime = performance.now() - startTime;
    
    res.status(500).json({ 
      error: 'Internal server error',
      meta: {
        processingTimeMs: Math.round(processingTime),
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Close database connections
  await commandProcessor.persistentManager.prisma.$disconnect();
  
  // Close Redis connections
  commandProcessor.ephemeralManager.redis.disconnect();
  commandProcessor.streamManager.redis.disconnect();
  commandProcessor.cache.redis.disconnect();
  
  process.exit(0);
});

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

export default app;
