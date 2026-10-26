import { describe, expect, it } from 'vitest';
import { trend } from './admin-stats.service.js';

describe('trend', () => {
  it.each([
    [150n, 100n, 50, 'up'],
    [50n, 100n, -50, 'down'],
    [100n, 100n, 0, 'neutral'],
    [5n, 0n, 100, 'up'],
    [0n, 0n, 0, 'neutral'],
    [1n, 3n, -66.6, 'down'],
  ])('%s vs %s → %s%% (%s)', (current, previous, expected, type) => {
    expect(trend(current, previous)).toEqual({ trend: expected, trendType: type });
  });

  it('stays exact for sums beyond 2^53', () => {
    expect(trend(2n ** 62n, 2n ** 61n)).toEqual({ trend: 100, trendType: 'up' });
  });
});
