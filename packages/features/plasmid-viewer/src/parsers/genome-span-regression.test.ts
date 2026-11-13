import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import { parseGenBank } from './genbank';
import {
  reportGenomeSpanningFeatures,
  formatGenomeSpanReport,
  MAX_GENOME_SPANNING_FEATURES,
} from './genome-span-diagnostics';

const GENOME_FIXTURES = [
  'vibrio-cholerae-N16961/NC_002505.1.gb',
  'vibrio-cholerae-N16961/NC_002506.1.gb',
  'ecoli-W3110/NC_007779.1.gb',
] as const;

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../../../../../test-fixtures/genomes/${rel}`, import.meta.url));
}

describe(' — genome-spanning feature regression net', () => {
  for (const rel of GENOME_FIXTURES) {
    it(`plasmid-viewer parser does not manufacture genome-spanning arcs: ${rel}`, () => {
      const content = readFileSync(fixturePath(rel), 'utf8');
      const parsed = parseGenBank(content);

      expect(parsed.features.length, `parsed too few features from ${rel}`).toBeGreaterThan(1000);

      const report = reportGenomeSpanningFeatures(parsed.features, parsed.length, 0.5);

      expect(
        report.count,
        formatGenomeSpanReport(report, `plasmid-viewer features in ${rel}`)
      ).toBeLessThanOrEqual(MAX_GENOME_SPANNING_FEATURES);
    });

    it(`sequence-utils parser does not manufacture genome-spanning annotations: ${rel}`, () => {
      const content = readFileSync(fixturePath(rel), 'utf8');
      const full = parseGenBankFull(content);

      expect(full.annotations.length, `parsed too few annotations from ${rel}`).toBeGreaterThan(
        1000
      );

      const report = reportGenomeSpanningFeatures(full.annotations, full.sequence.length, 0.5);

      expect(
        report.count,
        formatGenomeSpanReport(report, `sequence-utils annotations in ${rel}`)
      ).toBeLessThanOrEqual(MAX_GENOME_SPANNING_FEATURES);
    });
  }
});
