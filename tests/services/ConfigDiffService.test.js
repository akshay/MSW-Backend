import { ConfigDiffService } from '../../services/ConfigDiffService.js';
import { NULL_MARKER } from '../../util/config-diff-types.js';

function buildService(overrides = {}) {
  return new ConfigDiffService({
    redis: {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    },
    manifestService: {
      getManifestByVersion: jest.fn(),
    },
    ...overrides,
  });
}

describe('ConfigDiffService deep diff', () => {
  test('computes and applies deep object diffs with array replacement', () => {
    const service = buildService();
    const previous = {
      global: {
        runtime: {
          sound: {
            playerSkillCooldownMs: 80,
          },
        },
        jobAdvLevel: [0, 10, 30],
        flags: {
          alpha: true,
          beta: false,
        },
      },
    };

    const current = {
      global: {
        runtime: {
          sound: {
            playerSkillCooldownMs: 150,
            mute: false,
          },
        },
        jobAdvLevel: [0, 12, 34, 70],
        flags: {
          alpha: true,
          gamma: true,
        },
      },
    };

    const diff = service.computeDiff(previous, current);
    expect(diff).toEqual({
      global: {
        runtime: {
          sound: {
            playerSkillCooldownMs: 150,
            mute: false,
          },
        },
        jobAdvLevel: [0, 12, 34, 70],
        flags: {
          beta: NULL_MARKER,
          gamma: true,
        },
      },
    });

    const applied = service.applyDiff(previous, diff);
    expect(applied).toEqual(current);
  });

  test('returns empty diff for unchanged objects', () => {
    const service = buildService();
    const base = {
      global: {
        maxLevel: 250,
      },
    };

    expect(service.computeDiff(base, base)).toEqual({});
  });

  test('replaces primitive/object values when types change', () => {
    const service = buildService();

    const previous = {
      global: {
        mixed: 10,
        nested: {
          value: 1,
        },
      },
    };

    const current = {
      global: {
        mixed: {
          enabled: true,
        },
        nested: 0,
      },
    };

    const diff = service.computeDiff(previous, current);
    expect(diff).toEqual({
      global: {
        mixed: {
          enabled: true,
        },
        nested: 0,
      },
    });

    expect(service.applyDiff(previous, diff)).toEqual(current);
  });
});

describe('ConfigDiffService getDiff filtering', () => {
  test('ignores non-allowlisted files and keeps allowlisted files', async () => {
    const manifestService = {
      getManifestByVersion: jest.fn(),
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };

    const service = buildService({ manifestService, redis });
    const oldManifest = {
      snapshotVersion: 10,
      files: {
        'global.json': { sha256: 'g1' },
        'provider.json': { sha256: 'p1' },
        'script_js.json': { sha256: 's1' },
      },
    };
    const newManifest = {
      snapshotVersion: 11,
      files: {
        'global.json': { sha256: 'g2' },
        'provider.json': { sha256: 'p2' },
        'script_js.json': { sha256: 's2' },
      },
    };

    manifestService.getManifestByVersion
      .mockResolvedValueOnce(oldManifest)
      .mockResolvedValueOnce(newManifest);

    jest.spyOn(service, 'readConfigFile').mockImplementation(async (fileName, fileMeta) => {
      if (fileName === 'global.json') {
        return fileMeta.sha256 === 'g1'
          ? { runtime: { maxUsers: 100 } }
          : { runtime: { maxUsers: 200 } };
      }
      if (fileName === 'provider.json') {
        return fileMeta.sha256 === 'p1'
          ? { skill: { all: { 1: { level: 1 } } } }
          : { skill: { all: { 1: { level: 2 } } } };
      }
      throw new Error(`Unexpected file read: ${fileName}`);
    });

    const diff = await service.getDiff(10, 11, 'staging');
    expect(diff.fromVersion).toBe(10);
    expect(diff.toVersion).toBe(11);
    expect(diff.files).toEqual({
      'global.json': {
        runtime: {
          maxUsers: 200,
        },
      },
      'provider.json': {
        skill: {
          all: {
            1: {
              level: 2,
            },
          },
        },
      },
    });
  });

  test('emits file deletion for allowlisted files only', async () => {
    const manifestService = {
      getManifestByVersion: jest.fn(),
    };

    const service = buildService({ manifestService });
    const oldManifest = {
      snapshotVersion: 30,
      files: {
        'provider.json': { sha256: 'p1' },
        'script_js.json': { sha256: 's1' },
      },
    };
    const newManifest = {
      snapshotVersion: 31,
      files: {},
    };

    manifestService.getManifestByVersion
      .mockResolvedValueOnce(oldManifest)
      .mockResolvedValueOnce(newManifest);

    const diff = await service.getDiff(30, 31, 'production');
    expect(diff.files).toEqual({
      'provider.json': {
        __deleted__: NULL_MARKER,
      },
    });
  });
});
