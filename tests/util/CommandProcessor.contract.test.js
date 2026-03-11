import {
  decodeCloudSaveMessage,
  buildCloudSearchResult,
  buildCloudTopResult,
} from '../../util/CloudRunnerContract.js';

describe('CloudRunnerContract', () => {
  test('decodeCloudSaveMessage converts messageJson to attributes', () => {
    expect(
      decodeCloudSaveMessage({
        messageJson: '{"name":"Knights","level":3}',
      })
    ).toEqual({
      name: 'Knights',
      level: 3,
    });
  });

  test('buildCloudSearchResult wraps backend rows in the typed envelope', () => {
    expect(
      buildCloudSearchResult([
        {
          entity_type: 'Guild',
          id: 'guild_a',
          world_id: 2,
          attributes: {
            name: 'Knights',
          },
          rank_scores: {
            fameScore: {
              1: 100,
            },
          },
        },
      ])
    ).toEqual({
      ok: true,
      code: '',
      rows: [
        {
          entityType: 'Guild',
          id: 'guild_a',
          worldId: 2,
          attributesJson: '{"name":"Knights"}',
          rankScoresJson: '{"fameScore":{"1":100}}',
        },
      ],
    });
  });

  test('buildCloudTopResult wraps ranked rows in the typed envelope', () => {
    expect(
      buildCloudTopResult([
        {
          entity_type: 'Guild',
          id: 'guild_a',
          world_id: 2,
          attributes: {
            name: 'Knights',
          },
          rank_scores: {
            fameScore: {
              1: 100,
            },
          },
          rank_value: 100,
        },
      ])
    ).toEqual({
      ok: true,
      code: '',
      rows: [
        {
          entityType: 'Guild',
          id: 'guild_a',
          worldId: 2,
          attributesJson: '{"name":"Knights"}',
          rankScoresJson: '{"fameScore":{"1":100}}',
          rankValue: 100,
        },
      ],
    });
  });
});
