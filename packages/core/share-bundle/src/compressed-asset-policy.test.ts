import { describe, expect, it } from 'vitest';
import { classifyShareFile, classifyValidatedNotebookAssetPath } from './index';
import { workspaceSyncSensitivePathExclusion } from './shared';

const raw = [
  'reads.fastq',
  'reads.fq',
  'signal.ab1',
  'signal.abi',
  'alignments.bam',
  'variants.vcf',
];
const references = ['features.gff', 'features.gff3', 'features.gtf', 'reference.fai'];

describe('compression-aware notebook sharing policy', () => {
  for (const suffix of ['', '.gz', '.bgz', '.bz2', '.xz', '.zst', '.zip']) {
    for (const [names, reason] of [
      [raw, 'private-raw-data'],
      [references, 'reference-pointer'],
    ] as const) {
      it(`keeps ${reason} excluded under ${suffix || 'no compression'}`, () => {
        for (const name of names) {
          const file = `Lab notes/assets/${name}${suffix}`;
          expect(workspaceSyncSensitivePathExclusion(file)).toBe(reason);
          expect(classifyShareFile(file, 20)).toEqual({ action: 'exclude', reason });
          expect(classifyValidatedNotebookAssetPath(file, 'Lab notes', 20)).toEqual({
            action: 'exclude',
            reason,
          });
        }
      });
    }
  }
  it('handles uppercase and nested compression while preserving ordinary attachments', () => {
    expect(
      classifyValidatedNotebookAssetPath('Notes/assets/READS.FASTQ.GZ.XZ', 'Notes', 20)
    ).toEqual({ action: 'exclude', reason: 'private-raw-data' });
    for (const name of ['figure.png', 'model.bin', 'report.pdf.gz']) {
      expect(classifyValidatedNotebookAssetPath(`Notes/assets/${name}`, 'Notes', 20)).toMatchObject(
        { action: 'include', kind: 'notebook' }
      );
    }
  });
});
