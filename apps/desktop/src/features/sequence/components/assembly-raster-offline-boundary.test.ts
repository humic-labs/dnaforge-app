// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENT_DIR = resolve(process.cwd(), 'src/features/sequence/components');

describe('assembly annotation raster offline boundary', () => {
  it('does not authorize whole-assembly raster extraction from the interactive tab', () => {
    const source = readFileSync(resolve(COMPONENT_DIR, 'IndexedGenomeTab.tsx'), 'utf8');

    expect(source).not.toContain('useAssemblyOverviewTexturePrewarm');
    expect(source).not.toContain('__webglExtractGenomeWideTexture');
    expect(source).not.toContain('writeAssemblyOverviewTexture');
  });
});
