import { describe, expect, it } from 'vitest';
import { hostedReferenceCatalogForRuntime } from './hosted-reference-catalog-fixture';
import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';

describe('isolated reference-upgrade fixtures', () => {
  it('leaves normal reference authority unchanged', async () => {
    await expect(
      hostedReferenceCatalogForRuntime({
        catalog: HOSTED_REFERENCE_CATALOG_V1,
        isPackaged: false,
        explicitE2e: false,
      })
    ).resolves.toBe(HOSTED_REFERENCE_CATALOG_V1);
  });
  it('refuses fixture access outside explicit unpackaged tests before reading a file', async () => {
    for (const mode of [
      { isPackaged: true, explicitE2e: true },
      { isPackaged: false, explicitE2e: false },
    ]) {
      await expect(
        hostedReferenceCatalogForRuntime({
          catalog: HOSTED_REFERENCE_CATALOG_V1,
          ...mode,
          fixturePath: '/absent/fixture.json',
        })
      ).rejects.toThrow('unpackaged explicit E2E');
    }
  });
});
