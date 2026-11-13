import { describe, expect, it } from 'vitest';

import { matchesSqlLike } from './platform-mocks';

describe('matchesSqlLike', () => {
  it('anchors the whole value, so a suffix pattern cannot match a longer path', () => {
    expect(matchesSqlLike('/ws/sequences/pUC19.gb', '%/pUC19.gb')).toBe(true);
    expect(matchesSqlLike('/ws/Reference chips', '%/pUC19.gb')).toBe(false);
  });

  it('treats _ as exactly one character', () => {
    expect(matchesSqlLike('E1010m_CD.gb', '%/E1010m_CD.gb')).toBe(false);
    expect(matchesSqlLike('/kit/E1010mXCD.gb', '%/E1010m_CD.gb')).toBe(true);
  });

  it('honours a backslash escape, so an escaped _ is a literal underscore', () => {
    expect(matchesSqlLike('/kit/E1010m_CD.gb', '%/E1010m\\_CD.gb')).toBe(true);
    expect(matchesSqlLike('/kit/E1010mXCD.gb', '%/E1010m\\_CD.gb')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern rather than executing them', () => {
    expect(matchesSqlLike('/ws/a.b.gb', '%/a.b.gb')).toBe(true);
    expect(matchesSqlLike('/ws/axbxgb', '%/a.b.gb')).toBe(false);
  });

  it('matches an empty run for %', () => {
    expect(matchesSqlLike('/pUC19.gb', '%/pUC19.gb')).toBe(true);
  });
});
