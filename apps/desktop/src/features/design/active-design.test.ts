import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as designStore from './store';
import * as publicDesignStore from './public/store';

const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

describe('design store public surface', () => {
  it('does not export unused useActiveDesign or CopiedAnnotation', () => {
    expect(designStore).not.toHaveProperty('useActiveDesign');
    expect(publicDesignStore).not.toHaveProperty('useActiveDesign');
    expect(typeof designStore.useDesignStore).toBe('function');
    expect(indexSource).not.toMatch(/useActiveDesign/);
    expect(indexSource).not.toMatch(/CopiedAnnotation/);
    expect(indexSource).toMatch(/CopiedRegion/);
  });
});
