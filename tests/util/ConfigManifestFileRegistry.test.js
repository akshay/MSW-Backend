import {
  getTrackedConfigManifestFiles,
  isTrackedConfigManifestFile,
} from '../../util/ConfigManifestFileRegistry.js';

describe('ConfigManifestFileRegistry', () => {
  test('tracks hot-reload config files and raw nx dashboard assets', () => {
    expect(isTrackedConfigManifestFile('global.json')).toBe(true);
    expect(isTrackedConfigManifestFile('provider/Mob.nx.json')).toBe(true);
    expect(isTrackedConfigManifestFile('Augment.nx.json')).toBe(true);
    expect(isTrackedConfigManifestFile('provider/String.nx.json')).toBe(true);
    expect(isTrackedConfigManifestFile('script_js.json')).toBe(false);
  });

  test('lists tracked raw nx assets', () => {
    const tracked = getTrackedConfigManifestFiles();
    expect(tracked).toContain('Augment.nx.json');
    expect(tracked).toContain('Mob.nx.json');
    expect(tracked).toContain('String.nx.json');
  });
});
