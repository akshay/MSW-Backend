import { ConfigDashboard } from '../../monitoring/config-dashboard.js';

describe('ConfigDashboard', () => {
  test('renders mob drop preview controls and fetch script', () => {
    const dashboard = new ConfigDashboard();
    const html = dashboard.renderDashboardHTML({
      generatedAt: '2026-03-11T00:00:00.000Z',
      byEnvironment: {
        staging: {
          currentVersion: 10,
          manifestId: 'manifest-10',
          versionDistribution: [],
          syncRequests: {
            no_change: 0,
            diff: 0,
            full_sync: 0,
            error: 0,
          },
          averageLagSeconds: 0,
        },
      },
      recentPublishes: [],
      recentRollbacks: [],
    });

    expect(html).toContain('Mob Drop Preview');
    expect(html).toContain('mob-drop-form');
    expect(html).toContain('/config/mob-drops/preview');
    expect(html).toContain('mob-drop-results');
  });
});
