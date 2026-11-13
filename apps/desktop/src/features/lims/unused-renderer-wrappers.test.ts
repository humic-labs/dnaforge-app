import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as operations from './operations';

const here = dirname(fileURLToPath(import.meta.url));

const RETIRED = [
  'countLimsEntitiesByKind',
  'setLimsIdScheme',
  'backfillLimsRegistryIds',
  'getLimsStrainGenomeSummaries',
  'restoreLimsPendingRef',
  'recordLimsStrainParentGenome',
] as const;

describe('retired LIMS renderer wrappers', () => {
  it('does not export unused registry wrappers', () => {
    for (const name of RETIRED) {
      expect(operations).not.toHaveProperty(name);
    }
    expect(typeof operations.registerLimsEntity).toBe('function');
    expect(typeof operations.applyLimsImportBatch).toBe('function');
    const dna = readFileSync(join(here, 'dna-sequence.ts'), 'utf8');
    expect(dna).not.toMatch(/function sourceFormatForPath\b/);
    expect(dna).toMatch(/export [^;]*\bbuildFileDnaSequenceRef\b/);
    const validation = readFileSync(
      join(here, '../design/validation/golden-gate-overhangs.ts'),
      'utf8'
    );
    expect(validation).not.toMatch(/function collectAssemblyOverhangs\b/);
    expect(validation).not.toMatch(/function findCompatiblePositions\b/);
    expect(validation).toMatch(/function validateAssembly\b/);
  });
});
