import {
  getSupportedConfigSyncFiles,
  isProviderFile,
  isSupportedConfigSyncFile,
  normalizeConfigSyncFileName,
  resolveConfigSectionForFile,
  resolveConfigSyncTargetForFile,
} from '../../util/ConfigSyncFileRouter.js';

describe('ConfigSyncFileRouter', () => {
  test('normalizes file names consistently', () => {
    expect(normalizeConfigSyncFileName('CONFIG\\GLOBAL.JSON')).toBe('config/global.json');
  });

  test('resolves config sections for mapped files and aliases', () => {
    expect(resolveConfigSectionForFile('global.json')).toBe('global');
    expect(resolveConfigSectionForFile('config/global.json')).toBe('global');
    expect(resolveConfigSectionForFile('ui_plans/index.json')).toBe('uiPlans');
    expect(resolveConfigSectionForFile('unknown.json')).toBe('');
  });

  test('detects provider sync file', () => {
    expect(isProviderFile('provider.json')).toBe(true);
    expect(isProviderFile('config/provider.json')).toBe(true);
    expect(isProviderFile('mob.json')).toBe(false);
  });

  test('supports only mapped config files plus provider', () => {
    expect(isSupportedConfigSyncFile('global.json')).toBe(true);
    expect(isSupportedConfigSyncFile('config/global.json')).toBe(true);
    expect(isSupportedConfigSyncFile('provider.json')).toBe(true);
    expect(isSupportedConfigSyncFile('script_js.json')).toBe(false);
    expect(isSupportedConfigSyncFile('ui_custom.json')).toBe(false);
  });

  test('resolves sync targets', () => {
    expect(resolveConfigSyncTargetForFile('mob.json')).toEqual({
      store: 'config',
      section: 'mob',
    });

    expect(resolveConfigSyncTargetForFile('provider.json')).toEqual({
      store: 'provider',
    });

    expect(resolveConfigSyncTargetForFile('script_js.json')).toBeNull();
  });

  test('lists supported sync files', () => {
    const supported = getSupportedConfigSyncFiles();
    expect(supported).toContain('provider.json');
    expect(supported).toContain('global.json');
    expect(supported).toContain('ui_plans/index.json');
    expect(supported).not.toContain('script_js.json');
  });
});
