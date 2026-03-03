export class ConfigKeyGenerator {
  static MANIFEST_TTL_SECONDS = 24 * 60 * 60;

  static DIFF_TTL_SECONDS = 60 * 60;

  static HEALTH_TTL_SECONDS = null;

  constructor(environment) {
    this.environment = environment;
  }

  currentManifest() {
    return `${this.environment}:config:current_manifest`;
  }

  versionManifest(snapshotVersion) {
    return `${this.environment}:config:version:${snapshotVersion}`;
  }

  diff(fromVersion, toVersion) {
    return `${this.environment}:config:diff:${fromVersion}:${toVersion}`;
  }

  health(snapshotVersion) {
    return `${this.environment}:config:health:${snapshotVersion}`;
  }

  publishLock() {
    return `${this.environment}:config:lock:publish`;
  }

  healthTotals() {
    return `${this.environment}:config:health:totals`;
  }

  healthCurrentVersion() {
    return `${this.environment}:config:health:current_version`;
  }

  rollbackAuditLog() {
    return `${this.environment}:config:audit:rollback`;
  }
}
