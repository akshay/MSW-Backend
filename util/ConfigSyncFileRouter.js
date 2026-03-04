const CONFIG_SECTION_BY_FILE = Object.freeze({
  'global.json': 'global',
  'item.json': 'item',
  'items.json': 'item',
  'job.json': 'job',
  'jobs.json': 'job',
  'map.json': 'map',
  'maps.json': 'map',
  'mob.json': 'mob',
  'mobs.json': 'mob',
  'npc.json': 'npc',
  'npcs.json': 'npc',
  'cloud.json': 'cloud',
  'script.json': '_script',
  'ui_plans.json': 'uiPlans',
  'ui_plans/index.json': 'uiPlans',
});

const PROVIDER_FILE_NAME = 'provider.json';

export function normalizeConfigSyncFileName(rawFileName) {
  return String(rawFileName || '')
    .toLowerCase()
    .replace(/\\/g, '/');
}

export function resolveConfigSectionForFile(rawFileName) {
  const normalized = normalizeConfigSyncFileName(rawFileName);
  if (!normalized) {
    return '';
  }

  const direct = CONFIG_SECTION_BY_FILE[normalized];
  if (direct) {
    return direct;
  }

  const baseName = normalized.split('/').pop() || normalized;
  return CONFIG_SECTION_BY_FILE[baseName] || '';
}

export function isProviderFile(rawFileName) {
  const normalized = normalizeConfigSyncFileName(rawFileName);
  if (!normalized) {
    return false;
  }

  if (normalized === PROVIDER_FILE_NAME) {
    return true;
  }

  const baseName = normalized.split('/').pop();
  return baseName === PROVIDER_FILE_NAME;
}

export function resolveConfigSyncTargetForFile(rawFileName) {
  const section = resolveConfigSectionForFile(rawFileName);
  if (section) {
    return { store: 'config', section };
  }

  if (isProviderFile(rawFileName)) {
    return { store: 'provider' };
  }

  return null;
}

export function isSupportedConfigSyncFile(rawFileName) {
  return resolveConfigSyncTargetForFile(rawFileName) !== null;
}

export function getSupportedConfigSyncFiles() {
  const items = new Set([
    ...Object.keys(CONFIG_SECTION_BY_FILE),
    PROVIDER_FILE_NAME,
  ]);
  return [...items].sort();
}
