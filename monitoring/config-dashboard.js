export class ConfigDashboard {
  constructor() {
    this.syncRequestsByEnvironment = new Map();
    this.versionLagSamplesByEnvironment = new Map();
    this.publishEvents = [];
    this.rollbackEvents = [];
  }

  ensureSyncCounters(environment) {
    if (!this.syncRequestsByEnvironment.has(environment)) {
      this.syncRequestsByEnvironment.set(environment, {
        no_change: 0,
        diff: 0,
        full_sync: 0,
        error: 0
      });
    }

    if (!this.versionLagSamplesByEnvironment.has(environment)) {
      this.versionLagSamplesByEnvironment.set(environment, []);
    }
  }

  recordSyncRequest(environment, responseType, versionLagSeconds = 0) {
    this.ensureSyncCounters(environment);
    const counters = this.syncRequestsByEnvironment.get(environment);
    counters[responseType] = (counters[responseType] || 0) + 1;

    const lags = this.versionLagSamplesByEnvironment.get(environment);
    lags.push(Number(versionLagSeconds) || 0);
    if (lags.length > 5000) {
      lags.shift();
    }
  }

  recordPublish(environment, durationSeconds, version, label = null) {
    this.publishEvents.push({
      timestamp: new Date().toISOString(),
      environment,
      durationSeconds: Number(durationSeconds) || 0,
      version,
      label
    });

    if (this.publishEvents.length > 200) {
      this.publishEvents.shift();
    }
  }

  recordRollback(environment, targetVersion, newVersion) {
    this.rollbackEvents.push({
      timestamp: new Date().toISOString(),
      environment,
      targetVersion,
      newVersion
    });

    if (this.rollbackEvents.length > 200) {
      this.rollbackEvents.shift();
    }
  }

  getSyncCounts(environment) {
    this.ensureSyncCounters(environment);
    return this.syncRequestsByEnvironment.get(environment);
  }

  getAverageLag(environment) {
    const samples = this.versionLagSamplesByEnvironment.get(environment) || [];
    if (samples.length === 0) {
      return 0;
    }
    const total = samples.reduce((sum, value) => sum + value, 0);
    return total / samples.length;
  }

  async toPrometheus({ environments, healthService }) {
    const lines = [];

    lines.push('# HELP config_sync_requests_total Count of config sync responses by type');
    lines.push('# TYPE config_sync_requests_total counter');
    lines.push('# HELP config_version_lag_seconds Average client version lag');
    lines.push('# TYPE config_version_lag_seconds gauge');
    lines.push('# HELP config_publish_duration_seconds Publish duration events');
    lines.push('# TYPE config_publish_duration_seconds summary');
    lines.push('# HELP config_clients_by_version Clients observed on each version');
    lines.push('# TYPE config_clients_by_version gauge');

    for (const environment of environments) {
      const counts = this.getSyncCounts(environment);
      for (const [responseType, count] of Object.entries(counts)) {
        lines.push(`config_sync_requests_total{environment="${environment}",response_type="${responseType}"} ${count}`);
      }

      const avgLag = this.getAverageLag(environment);
      lines.push(`config_version_lag_seconds{environment="${environment}"} ${avgLag.toFixed(4)}`);

      const publishForEnvironment = this.publishEvents.filter(event => event.environment === environment);
      const publishCount = publishForEnvironment.length;
      const publishSum = publishForEnvironment.reduce((sum, event) => sum + event.durationSeconds, 0);
      lines.push(`config_publish_duration_seconds_count{environment="${environment}"} ${publishCount}`);
      lines.push(`config_publish_duration_seconds_sum{environment="${environment}"} ${publishSum.toFixed(4)}`);

      if (healthService) {
        const distribution = await healthService.getVersionDistribution(environment);
        for (const item of distribution) {
          lines.push(
            `config_clients_by_version{environment="${environment}",version="${item.version}"} ${item.clientsOnVersion}`
          );
        }
      }
    }

    return lines.join('\n');
  }

  async getDashboardData({ environments, manifestService, healthService }) {
    const byEnvironment = {};

    for (const environment of environments) {
      const [manifest, distribution] = await Promise.all([
        manifestService.getCurrentManifest(environment),
        healthService.getVersionDistribution(environment)
      ]);

      byEnvironment[environment] = {
        currentVersion: manifest?.snapshotVersion ?? null,
        manifestId: manifest?.manifestId ?? null,
        versionDistribution: distribution.sort((a, b) => b.version - a.version),
        syncRequests: this.getSyncCounts(environment),
        averageLagSeconds: Number(this.getAverageLag(environment).toFixed(2))
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      byEnvironment,
      recentPublishes: this.publishEvents.slice(-25).reverse(),
      recentRollbacks: this.rollbackEvents.slice(-25).reverse()
    };
  }

  renderDashboardHTML(data) {
    const sections = Object.entries(data.byEnvironment).map(([environment, info]) => {
      const distributionRows = info.versionDistribution.length > 0
        ? info.versionDistribution.map(item => `
            <tr>
              <td>${item.version}</td>
              <td>${item.clientsOnVersion}</td>
              <td>${item.versionErrors}</td>
              <td>${item.bad ? 'bad' : 'good'}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="4">No version health data yet</td></tr>';

      return `
        <section class="card">
          <h2>${environment}</h2>
          <p><strong>Current Version:</strong> ${info.currentVersion ?? 'N/A'}</p>
          <p><strong>Manifest ID:</strong> ${info.manifestId ?? 'N/A'}</p>
          <p><strong>Average Version Lag:</strong> ${info.averageLagSeconds}s</p>
          <p><strong>Sync Requests:</strong> no_change=${info.syncRequests.no_change}, diff=${info.syncRequests.diff}, full_sync=${info.syncRequests.full_sync}, error=${info.syncRequests.error}</p>
          <table>
            <thead>
              <tr><th>Version</th><th>Clients</th><th>Errors</th><th>Status</th></tr>
            </thead>
            <tbody>${distributionRows}</tbody>
          </table>
        </section>
      `;
    }).join('');

    const publishRows = data.recentPublishes.length > 0
      ? data.recentPublishes.map(item => `
          <tr>
            <td>${item.timestamp}</td>
            <td>${item.environment}</td>
            <td>${item.version}</td>
            <td>${item.durationSeconds.toFixed(3)}s</td>
            <td>${item.label || ''}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="5">No publish events yet</td></tr>';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Config Version Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #0b1220; color: #e2e8f0; }
    h1 { margin-bottom: 8px; }
    .meta { color: #94a3b8; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
    .card { background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border-bottom: 1px solid #334155; padding: 8px; text-align: left; }
    th { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
    .section-title { margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Config Version Dashboard</h1>
  <div class="meta">Generated at ${data.generatedAt}</div>
  <div class="grid">${sections}</div>

  <h2 class="section-title">Recent Publish Events</h2>
  <table>
    <thead>
      <tr><th>Timestamp</th><th>Environment</th><th>Version</th><th>Duration</th><th>Label</th></tr>
    </thead>
    <tbody>${publishRows}</tbody>
  </table>
</body>
</html>`;
  }
}

export const configDashboard = new ConfigDashboard();
