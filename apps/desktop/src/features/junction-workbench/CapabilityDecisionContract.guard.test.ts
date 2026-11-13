// @vitest-environment node

import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { describe, expect, it } from 'vitest';

const UI_GLOBS = ['src/features/junction-workbench/**/*.tsx'];

const RAW_BIOLOGY_PATTERNS = [
  'isRestrictionDigestRegion',
  'sourceType',
  'rdOverhangs',
  'rdEnds',
  'rdSourceEnzyme',
  'rdSourceEnzymeName',
  'homologyJunctionEditability',
  'isGoldenGateJunctionOffsetLocked',
];

const VIEWPORT_LOCAL_SOURCE_FIELD_PATTERNS = [
  "field.kind === 'sourceContributionBoundary'",
  'field.kind === "sourceContributionBoundary"',
];

describe('junction workbench capability decision guard', () => {
  it('keeps raw biological editability decisions out of React UI files', () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of RAW_BIOLOGY_PATTERNS) {
        if (content.includes(pattern)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps product/source drag targeting behind the interaction capability adapter', () => {
    const offenders: string[] = [];
    const files = [
      'src/features/junction-workbench/RegisteredAssemblyViewport.tsx',
      'src/features/junction-workbench/RegisteredSequenceSurface.tsx',
      'src/features/junction-workbench/LinkedCameraGroup.tsx',
    ];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of VIEWPORT_LOCAL_SOURCE_FIELD_PATTERNS) {
        if (content.includes(pattern)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps React UI from dropping manifest fields behind model-level editability flags', () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('model.editable')) offenders.push(`${file}: model.editable`);
    }

    expect(offenders).toEqual([]);
  });
});

function uiFiles(): string[] {
  return UI_GLOBS.flatMap((pattern) =>
    globSync(pattern, {
      cwd: process.cwd(),
      absolute: false,
      nodir: true,
      ignore: ['src/features/junction-workbench/**/*.test.tsx'],
    })
  ).sort();
}
