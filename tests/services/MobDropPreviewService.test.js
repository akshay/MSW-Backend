import { MobDropPreviewService } from '../../services/MobDropPreviewService.js';

function buildSnapshot(files) {
  return {
    manifest: {
      snapshotVersion: 77,
      manifestId: 'manifest-77',
    },
    files,
  };
}

function buildService(files) {
  return new MobDropPreviewService({
    snapshotReader: {
      getCurrentSnapshot: jest.fn().mockResolvedValue(buildSnapshot(files)),
    },
  });
}

describe('MobDropPreviewService', () => {
  test('builds combined drop preview from config and nx assets', async () => {
    const service = buildService({
      'mob.json': {
        mobMinMesoRate: 4,
        mobMaxMesoRate: 6,
        combat: {
          cloudMobDropChance: 0.5,
        },
        mobGroups: {
          Normal: {
            normalMob: true,
            difficulty: 1,
          },
        },
        globalDrops: [
          {
            chance: 0.2,
            difficultyScalingChance: 0.05,
            itemIds: [2000000],
            mobGroups: ['Normal'],
            minLevel: 10,
          },
          {
            chance: 0.2,
            itemIds: [2000000],
            mobGroups: ['Normal'],
            minLevel: 10,
          },
          {
            chance: 0.15,
            sets: [347],
            jobRestricted: true,
            mobGroups: ['Normal'],
            minLevel: 10,
          },
        ],
      },
      'cloud.json': {
        mobDrops: {
          '100100': {
            itemIds: {
              '4000019': false,
              '4000020': true,
            },
          },
        },
      },
      'map.json': {
        bosses: {},
      },
      'Mob.nx.json': {
        all: {
          '100100': {
            info: {
              level: 20,
              boss: false,
              rareItemDropLevel: 0,
              explosiveReward: 0,
              hpTagColor: 0,
            },
          },
        },
      },
      'Augment.nx.json': {
        itemPrefixes: {
          'I:347:0:0:-1': {
            itemIds: {
              '1302000': true,
            },
          },
          'I:347:0:0:1': {
            itemIds: {
              '1302001': true,
            },
          },
          'I:347:0:0:2': {
            itemIds: {
              '1302002': true,
            },
          },
        },
      },
      'String.nx.json': {
        consume: {
          '2000000': {
            name: 'Red Potion',
          },
        },
        etc: {
          '4000019': {
            name: 'Snail Shell',
          },
          '4000020': {
            name: 'Quest Shell',
          },
        },
        eqp: {
          '1302000': {
            name: 'Sword A',
          },
          '1302001': {
            name: 'Sword B',
          },
          '1302002': {
            name: 'Sword C',
          },
        },
        mob: {
          '100100': 'Blue Snail',
        },
      },
    });

    const preview = await service.previewMobDrops({
      environment: 'staging',
      mobId: 100100,
    });

    expect(preview.snapshotVersion).toBe(77);
    expect(preview.mob.name).toBe('Blue Snail');
    expect(preview.profiles).toHaveLength(1);
    expect(preview.missingData).toEqual([]);

    const profile = preview.profiles[0];
    expect(profile.bossType).toBe('');

    const redPotion = profile.items.find((item) => item.itemId === 2000000);
    expect(redPotion.name).toBe('Red Potion');
    expect(redPotion.approxChance).toBeCloseTo(0.4, 4);

    const questShell = profile.items.find((item) => item.itemId === 4000020);
    expect(questShell.questOnly).toBe(true);
    expect(questShell.conditional).toBe(true);

    const swordIds = profile.items
      .filter((item) => item.jobRestricted === true)
      .map((item) => item.itemId)
      .sort();
    expect(swordIds).toEqual([1302000, 1302001, 1302002]);

    const mesos = profile.items.find((item) => item.kind === 'meso');
    expect(mesos.approxChance).toBe(1);
    expect(mesos.quantity.min).toBe(80);
    expect(mesos.quantity.max).toBe(120);
  });

  test('splits boss drops into separate profiles for ambiguous boss mappings', async () => {
    const service = buildService({
      'mob.json': {
        mobMinMesoRate: 0,
        mobMaxMesoRate: 0,
        combat: {
          cloudMobDropChance: 0.5,
        },
        mobGroups: {
          BossEasy: {
            bossTypes: ['ARKARIUM_EASY'],
            difficulty: 18,
          },
          BossNormal: {
            bossTypes: ['ARKARIUM_NORMAL'],
            difficulty: 20,
          },
        },
        globalDrops: [
          {
            chance: 0.2,
            itemIds: [4001000],
            mobGroups: ['BossEasy'],
          },
          {
            chance: 0.3,
            itemIds: [4001001],
            mobGroups: ['BossNormal'],
          },
        ],
      },
      'cloud.json': {
        mobDrops: {},
      },
      'map.json': {
        bosses: {
          ARKARIUM_EASY: {
            spawns: [{ mobId: 8860007 }],
          },
          ARKARIUM_NORMAL: {
            spawns: [{ mobId: 8860007 }],
          },
        },
      },
      'Mob.nx.json': {
        all: {
          '8860007': {
            info: {
              level: 140,
              boss: true,
            },
          },
        },
      },
      'Augment.nx.json': {
        itemPrefixes: {},
      },
      'String.nx.json': {
        etc: {
          '4001000': { name: 'Easy Token' },
          '4001001': { name: 'Normal Token' },
        },
        mob: {
          '8860007': 'Arkarium',
        },
      },
    });

    const preview = await service.previewMobDrops({
      environment: 'production',
      mobId: 8860007,
    });

    expect(preview.profiles).toHaveLength(2);
    expect(preview.profiles.map((profile) => profile.bossType).sort()).toEqual([
      'ARKARIUM_EASY',
      'ARKARIUM_NORMAL',
    ]);
  });

  test('returns missing data when required snapshot files are absent', async () => {
    const service = buildService({
      'mob.json': {
        mobGroups: {},
        globalDrops: [],
        combat: {
          cloudMobDropChance: 0.5,
        },
      },
      'cloud.json': {
        mobDrops: {},
      },
    });

    await expect(
      service.previewMobDrops({
        environment: 'staging',
        mobId: 100100,
      }),
    ).rejects.toMatchObject({
      code: 'missing_snapshot_files',
      missingData: expect.arrayContaining(['Augment.nx.json', 'Mob.nx.json', 'String.nx.json', 'map.json']),
    });
  });
});
