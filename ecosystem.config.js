/**
 * PM2 Ecosystem Configuration
 * Manages both main server and backup worker processes
 * 
 * Usage:
 *   pm2 start ecosystem.config.js                    # Start all processes
 *   pm2 start ecosystem.config.js --only msw-backend # Start only main server
 *   pm2 start ecosystem.config.js --only msw-backup-worker # Start only backup worker
 *   pm2 stop all                                     # Stop all processes
 *   pm2 restart all                                  # Restart all processes
 *   pm2 logs                                         # View logs
 *   pm2 monit                                        # Monitor processes
 */

module.exports = {
  apps: [
    {
      name: 'msw-backend',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      env: {
        NODE_ENV: 'development'
      },
      
      env_production: {
        NODE_ENV: 'production'
      },
      
      // Error handling
      restart_delay: 10000,
      max_restarts: 10,
      min_uptime: '10s',
      
      // Logging
      merge_logs: true,
      log_file: './logs/msw-backend.log',
      error_file: './logs/msw-backend-error.log',
      out_file: './logs/msw-backend-out.log'
    },
    {
      name: 'msw-backup-worker',
      script: 'workers/backup-worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      env: {
        NODE_ENV: 'development',
        BACKUP_ENABLED: 'false' // Disabled by default in development
      },
      
      env_production: {
        NODE_ENV: 'production',
        BACKUP_ENABLED: 'true',
        BACKUP_SCHEDULE: '0 */6 * * *',
        BACKUP_RETENTION_DAYS: '7',
        BACKUP_COMPRESSION_LEVEL: '6',
        BACKUP_WORKER_PORT: '3001',
        BACKUP_LOG_RETENTION_DAYS: '7'
      },
      
      // Error handling
      restart_delay: 60000, // Wait 60s before restart
      max_restarts: 3, // Max 3 restarts
      min_uptime: '30s',
      
      // Weekly restart for memory cleanup (Sundays at midnight)
      cron_restart: '0 0 * * 0',
      
      // Logging (7-day retention)
      merge_logs: true,
      log_file: './logs/msw-backup-worker.log',
      error_file: './logs/msw-backup-worker-error.log',
      out_file: './logs/msw-backup-worker-out.log'
    }
  ]
};
