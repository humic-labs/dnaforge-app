import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HOSTED_REFERENCE_CATALOG_V1 } from './hosted-reference-catalog';
import { hostedReferenceBrowserCatalogV1 } from './hosted-reference-browser-catalog';

const CHECKED_IN = resolve(__dirname, '../../shared/hosted-reference-browser-catalog.v1.json');

describe('hosted reference browser catalog', () => {
  it('is the exact projection of the prepared hosted catalog', () => {
    const projected = hostedReferenceBrowserCatalogV1();
    if (process.env.WRITE_HOSTED_REFERENCE_BROWSER_CATALOG === '1') {
      writeFileSync(CHECKED_IN, `${JSON.stringify(projected, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(CHECKED_IN, 'utf8'))).toEqual(projected);
  });

  it('carries every prepared publication manifest digest', () => {
    const projected = hostedReferenceBrowserCatalogV1();
    const prepared = HOSTED_REFERENCE_CATALOG_V1.filter((definition) => definition.preparedBundle);
    expect(projected.definitions.map((definition) => definition.listing.id)).toEqual(
      prepared.map((definition) => definition.id)
    );
    for (const [index, definition] of projected.definitions.entries()) {
      expect(definition.manifest).toEqual(prepared[index].preparedBundle?.manifest);
      expect(definition.contigs).toHaveLength(prepared[index].contigs.length);
    }
  });
});
