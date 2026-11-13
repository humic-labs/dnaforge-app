// @vitest-environment node

import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

const RENDERER_GLOBS = [
  'src/features/junction-workbench/RegisteredAssemblyViewport.tsx',
  'src/features/junction-workbench/RegisteredSequenceSurface.tsx',
  'src/features/junction-workbench/WorkbenchPaintingContract.ts',
  'src/features/junction-workbench/**/*.tsx',
  '../../packages/features/plasmid-viewer/src/components/webgl-map/**/*.ts',
  '../../packages/features/plasmid-viewer/src/components/webgl-map/**/*.tsx',
  '../../packages/core/genome-renderer/src/renderers/pixi/**/*.ts',
];

const FORBIDDEN_PATTERNS = [
  'sourcePositionContributesToProduct',
  "from './registered-source-axis'",
  'from "./registered-source-axis"',
  '../registered-source-axis',
  'bioCol < 0',
  'region.sourceStart',
  'region.sourceEnd',
];

describe('junction provenance renderer bypass guard', () => {
  it('prevents renderer files from reintroducing source contribution math', () => {
    const offenders: string[] = [];
    const files = new Set(
      RENDERER_GLOBS.flatMap((pattern) =>
        globSync(pattern, {
          cwd: process.cwd(),
          absolute: false,
          nodir: true,
        })
      )
    );

    for (const file of files) {
      if (file.includes('/provenance/')) continue;
      const content = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (content.includes(pattern)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
