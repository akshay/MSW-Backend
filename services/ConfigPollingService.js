import { EventEmitter } from 'events';
import { config } from '../config.js';

export class ConfigPollingService extends EventEmitter {
  constructor({ manifestService, diffService, healthService, pollIntervalMs = config.configSync.pollIntervalMs } = {}) {
    super();
    this.manifestService = manifestService;
    this.diffService = diffService;
    this.healthService = healthService;
    this.pollIntervalMs = pollIntervalMs;
    this.timers = new Map();
    this.activePolls = new Map();
    this.lastVersionByEnvironment = new Map();
  }

  startPolling(environment, intervalMs = this.pollIntervalMs) {
    if (this.timers.has(environment)) {
      return;
    }

    const effectiveInterval = Math.max(5000, intervalMs);
    const tick = async () => {
      if (this.activePolls.get(environment)) {
        return;
      }

      this.activePolls.set(environment, true);
      try {
        const manifest = await this.manifestService.getCurrentManifest(environment);
        if (!manifest) {
          return;
        }

        const previousVersion = this.lastVersionByEnvironment.get(environment);
        const currentVersion = Number(manifest.snapshotVersion);

        if (previousVersion === undefined) {
          this.lastVersionByEnvironment.set(environment, currentVersion);
          if (this.healthService) {
            await this.healthService.setCurrentVersion(currentVersion, environment);
          }
          return;
        }

        if (currentVersion !== previousVersion) {
          await this.diffService.getDiff(previousVersion, currentVersion, environment);
          this.lastVersionByEnvironment.set(environment, currentVersion);
          if (this.healthService) {
            await this.healthService.setCurrentVersion(currentVersion, environment);
          }
          this.emit('configUpdated', {
            environment,
            previousVersion,
            snapshotVersion: currentVersion,
          });
        }
      } catch (error) {
        this.emit('pollError', { environment, error });
      } finally {
        this.activePolls.set(environment, false);
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, effectiveInterval);

    this.timers.set(environment, timer);
  }

  stopPolling(environment = null) {
    if (environment) {
      const timer = this.timers.get(environment);
      if (timer) {
        clearInterval(timer);
        this.timers.delete(environment);
      }
      return;
    }

    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  shutdown() {
    this.stopPolling();
  }
}
