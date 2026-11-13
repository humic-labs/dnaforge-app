// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { INDEXED_TRACK_DEV_OPTIMIZE_DEPS } from './indexed-track-dev-optimization';

describe('indexed-track development dependency optimization', () => {
  it('pre-bundles every package first discovered by a cold BigWig render', () => {
    expect(INDEXED_TRACK_DEV_OPTIMIZE_DEPS).toEqual(['@gmod/bbi', 'generic-filehandle2']);
  });
});
