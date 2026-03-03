export const ALERT_RULES = [
  {
    name: 'ConfigVersionDrift',
    severity: 'warning',
    description: 'More than 5% of clients are not on current version after rollout',
    threshold: '>5%'
  },
  {
    name: 'ConfigPublishFailure',
    severity: 'critical',
    description: 'Recent publish attempt failed or took too long',
    threshold: 'publish duration > 120s or publish error event'
  },
  {
    name: 'ConfigRollback',
    severity: 'info',
    description: 'A rollback was triggered',
    threshold: 'any rollback event'
  },
  {
    name: 'ConfigSyncErrors',
    severity: 'warning',
    description: 'More than 1% of sync requests are errors',
    threshold: '>1%'
  }
];

export async function evaluateConfigAlerts({ environment, currentVersion, healthService, dashboardMetrics }) {
  const alerts = [];

  if (currentVersion !== null) {
    const distribution = await healthService.getVersionDistribution(environment);
    const totalClients = distribution.reduce((sum, item) => sum + item.clientsOnVersion, 0);
    const currentClients = distribution
      .filter(item => item.version === Number(currentVersion))
      .reduce((sum, item) => sum + item.clientsOnVersion, 0);

    if (totalClients > 0) {
      const notCurrentPercent = ((totalClients - currentClients) / totalClients) * 100;
      if (notCurrentPercent > 5) {
        alerts.push({
          name: 'ConfigVersionDrift',
          severity: 'warning',
          message: `${notCurrentPercent.toFixed(2)}% of clients are not on current version ${currentVersion}`
        });
      }
    }
  }

  const syncCounts = dashboardMetrics.getSyncCounts(environment);
  const totalSync = Object.values(syncCounts).reduce((sum, count) => sum + count, 0);
  if (totalSync > 0) {
    const errorRate = ((syncCounts.error || 0) / totalSync) * 100;
    if (errorRate > 1) {
      alerts.push({
        name: 'ConfigSyncErrors',
        severity: 'warning',
        message: `Sync error rate is ${errorRate.toFixed(2)}%`
      });
    }
  }

  const recentPublishes = dashboardMetrics.publishEvents
    .filter(event => event.environment === environment)
    .slice(-10);
  const slowPublish = recentPublishes.find(event => event.durationSeconds > 120);
  if (slowPublish) {
    alerts.push({
      name: 'ConfigPublishFailure',
      severity: 'critical',
      message: `Publish duration exceeded threshold (${slowPublish.durationSeconds.toFixed(2)}s)`
    });
  }

  const latestRollback = dashboardMetrics.rollbackEvents
    .filter(event => event.environment === environment)
    .slice(-1)[0];
  if (latestRollback) {
    alerts.push({
      name: 'ConfigRollback',
      severity: 'info',
      message: `Rollback executed from ${latestRollback.targetVersion} to ${latestRollback.newVersion}`
    });
  }

  return alerts;
}
