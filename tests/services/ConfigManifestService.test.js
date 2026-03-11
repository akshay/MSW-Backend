import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { ConfigManifestService } from '../../services/ConfigManifestService.js';

function buildService() {
  return new ConfigManifestService({
    redis: {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
    },
    b2: null,
  });
}

describe('ConfigManifestService collectConfigFiles', () => {
  test('includes sync files plus raw nx dashboard assets', async () => {
    const service = buildService();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'config-manifest-test-'));

    await fs.writeFile(path.join(tmpRoot, 'global.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'provider.json'), '{"ok":true}', 'utf8');
    await fs.mkdir(path.join(tmpRoot, 'provider'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'provider', 'Mob.nx.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'provider', 'Augment.nx.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'provider', 'String.nx.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'script_js.json'), '{"skip":true}', 'utf8');
    await fs.mkdir(path.join(tmpRoot, 'ui_plans'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'ui_plans', 'index.json'), '{"ok":true}', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'ui_plans', 'not_in_allowlist.json'), '{"skip":true}', 'utf8');

    try {
      const files = await service.collectConfigFiles(tmpRoot);
      const relative = files
        .map((absolutePath) => path.relative(tmpRoot, absolutePath).split(path.sep).join('/'))
        .sort();

      expect(relative).toEqual([
        'global.json',
        'provider.json',
        'provider/Augment.nx.json',
        'provider/Mob.nx.json',
        'provider/String.nx.json',
        'ui_plans/index.json',
      ]);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
