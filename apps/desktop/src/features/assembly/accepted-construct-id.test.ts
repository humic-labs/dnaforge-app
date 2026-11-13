// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { requireConstructId, resolveConstructIdForFinalize } from './accepted-construct-id';

describe('resolveConstructIdForFinalize', () => {
  it('prefers the requested id, then the design construct, then the existing package', () => {
    expect(
      resolveConstructIdForFinalize({
        requestedConstructId: 'requested',
        designConstructId: 'design-construct',
        existingPackageId: 'package',
      })
    ).toBe('requested');
    expect(
      resolveConstructIdForFinalize({
        designConstructId: 'design-construct',
        existingPackageId: 'package',
      })
    ).toBe('design-construct');
    expect(resolveConstructIdForFinalize({ existingPackageId: 'package' })).toBe('package');
  });

  it('mints a new id instead of falling back to a draft id', () => {
    expect(resolveConstructIdForFinalize({ mint: () => 'minted-construct' })).toBe(
      'minted-construct'
    );
    expect(() => requireConstructId(undefined, 'Finalize')).toThrow(/requires a construct id/i);
  });
});
