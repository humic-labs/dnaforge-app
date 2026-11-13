// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { isForgePackageScratchPath } from './forge-package';

describe('package-scratch directory recognition', () => {
  const token = '1753574400000-k3f9a2';

  it('accepts the scratch names the writer actually produces', () => {
    expect(isForgePackageScratchPath(`/w/.pUC19.staging-${token}`)).toBe(true);
    expect(isForgePackageScratchPath(`/w/.pUC19.previous-${token}`)).toBe(true);
    expect(isForgePackageScratchPath(`/w/.pUC19.v2.staging-${token}`)).toBe(true);
  });

  it('REFUSES anything a user could plausibly own', () => {
    for (const path of [
      '/w/pUC19',
      '/w/.pUC19.staging',
      `/w/pUC19.staging-${token}`,
      `/w/.pUC19.stagingX-${token}`,
      '/w/.git',
      '/w/.forge',
      '/Users/pc/Documents',
      '/',
      '',
      `/w/.pUC19.staging-${token}/..`,
      `/w/.pUC19.staging-${token}/inner`,
      '/w/.pUC19.staging-123-abc',
    ]) {
      expect(isForgePackageScratchPath(path), path).toBe(false);
    }
  });

  it('ignores a trailing separator rather than failing open or closed on it', () => {
    expect(isForgePackageScratchPath(`/w/.pUC19.staging-${token}/`)).toBe(true);
  });
});
