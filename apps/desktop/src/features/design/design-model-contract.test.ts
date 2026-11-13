// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SequenceDesign } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');

describe('SequenceDesign field-set contract', () => {
  it('has exactly the fields listed here — update this map deliberately', () => {
    const CONTRACT: Record<keyof SequenceDesign, true> = {
      id: true,
      name: true,
      regions: true,
      topology: true,
      assemblyMethod: true,
      defaultHomologyLength: true,
      homologyRegions: true,
      designPrimers: true,
      spacers: true,
      status: true,
      assemblyState: true,
      validationErrors: true,
      version: true,
      pcrPolymerase: true,
      primerDesignConstraints: true,
      createdAt: true,
      updatedAt: true,
      goldenGateConfig: true,
      goldenGateJunctions: true,
      goldenGateSchema: true,
      backboneSequenceId: true,
      assemblyWorkbench: true,
      acceptedAssemblyVersions: true,
      selectedJunctionIndex: true,
      proposedPlans: true,
      assemblyMethodDrafts: true,
      libraryOrigin: true,
      nebuilderResection: true,
      sourceContext: true,
    };

    expect(Object.keys(CONTRACT).length).toBeGreaterThan(0);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

describe('no use-site widening of core design types', () => {
  const BANNED = /\b(SequenceDesign|DesignRegion|DesignSpacer)\s*&\s*\{/;

  it('never widens SequenceDesign / DesignRegion / DesignSpacer with an inline intersection', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file.endsWith('design-model-contract.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (BANNED.test(line)) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'Add the field to the interface in features/design/types.ts instead. An inline ' +
        'intersection manufactures the field at the use site, so the compiler cannot tell ' +
        'you the model never got it.'
    ).toEqual([]);
  });
});
