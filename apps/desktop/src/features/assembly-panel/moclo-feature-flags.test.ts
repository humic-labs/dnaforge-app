// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMocloMapSchemaStripEnabled } from './moclo-feature-flags';

describe('MoClo feature flags', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the map schema strip off unless it is explicitly enabled', () => {
    vi.stubEnv('VITE_ENABLE_MOCLO_MAP_SCHEMA_STRIP', '');
    expect(isMocloMapSchemaStripEnabled()).toBe(false);

    vi.stubEnv('VITE_ENABLE_MOCLO_MAP_SCHEMA_STRIP', 'true');
    expect(isMocloMapSchemaStripEnabled()).toBe(true);
  });
});
