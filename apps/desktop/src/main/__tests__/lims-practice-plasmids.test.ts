import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import {
  PRACTICE_INSERT_LENGTH,
  PRACTICE_PLASMID_BACKBONES,
  PRACTICE_PLASMID_COUNT,
  buildPracticePlasmids,
  junctionsOutsideFeatures,
} from '../lims-practice-plasmids';

const REPO_ROOT = join(__dirname, '../../../../..');
const SAMPLE_WORKSPACE = 'apps/desktop/resources/sample-workspaces/standard-samples/workspace/';
const readRepoFile = (relativePath: string) => readFileSync(join(REPO_ROOT, relativePath), 'utf8');

const MARKER_EVIDENCE: Record<string, RegExp> = {
  Ampicillin: /\bAmpR\b|\bbla\b|beta-lactamase|β-lactamase/i,
  Kanamycin: /KanR|neomycin phosphotransferase/i,
  Tetracycline: /\btet\b|tetracycline/i,
  Gentamicin: /gentamicin/i,
};

function featureText(path: string): string {
  return parseGenBankFull(readRepoFile(path))
    .annotations.map((feature) =>
      [feature.name, feature.label, ...Object.values(feature.qualifiers ?? {}).flat()].join(' ')
    )
    .join('\n');
}

describe('synthetic practice plasmids', () => {
  const plasmids = buildPracticePlasmids(readRepoFile);

  it('builds the same 500 unique plasmids on every load', () => {
    expect(plasmids).toHaveLength(PRACTICE_PLASMID_COUNT);
    expect(buildPracticePlasmids(readRepoFile)).toEqual(plasmids);
    expect(new Set(plasmids.map((plasmid) => plasmid.bases)).size).toBe(PRACTICE_PLASMID_COUNT);
    expect(new Set(plasmids.map((plasmid) => plasmid.name)).size).toBe(PRACTICE_PLASMID_COUNT);
    expect(plasmids[0]).toMatchObject({ id: 'syn-0001', name: 'pSYN-0001' });
    expect(new Set(plasmids.map((plasmid) => plasmid.backbone))).toEqual(
      new Set(PRACTICE_PLASMID_BACKBONES.map((backbone) => backbone.name))
    );
  });

  it('splices one random insert into a backbone gap without touching its bases', () => {
    const backbones = new Map(
      PRACTICE_PLASMID_BACKBONES.map((backbone) => {
        const record = parseGenBankFull(readRepoFile(backbone.path));
        const features = record.annotations.filter((feature) => feature.type !== 'source');
        return [
          backbone.name,
          {
            sequence: record.sequence.toUpperCase(),
            junctions: new Set(junctionsOutsideFeatures(record.sequence.length, features)),
          },
        ];
      })
    );
    for (const plasmid of plasmids) {
      const backbone = backbones.get(plasmid.backbone)!;
      expect(plasmid.insertLength).toBeGreaterThanOrEqual(PRACTICE_INSERT_LENGTH.min);
      expect(plasmid.insertLength).toBeLessThanOrEqual(PRACTICE_INSERT_LENGTH.max);
      expect(plasmid.bases).toHaveLength(backbone.sequence.length + plasmid.insertLength);
      expect(plasmid.bases).toMatch(/^[ACGT]+$/);
      expect(backbone.junctions.has(plasmid.insertAfter), plasmid.name).toBe(true);
      expect(
        plasmid.bases.slice(0, plasmid.insertAfter) +
          plasmid.bases.slice(plasmid.insertAfter + plasmid.insertLength)
      ).toBe(backbone.sequence);
    }
  });

  it('uses only public-domain NCBI backbones whose annotations carry each listed marker', () => {
    const provenance = JSON.parse(readRepoFile(`${SAMPLE_WORKSPACE}PROVENANCE.json`)) as {
      entries: Array<{ path: string; source: string; license: string }>;
    };
    for (const backbone of PRACTICE_PLASMID_BACKBONES) {
      const record = provenance.entries.find(
        (entry) => `${SAMPLE_WORKSPACE}${entry.path}` === backbone.path
      );
      expect(record, backbone.name).toBeDefined();
      expect(record?.source, backbone.name).toMatch(/^NCBI\b/);
      expect(record?.license, backbone.name).toBe('public-domain');
      const text = featureText(backbone.path);
      for (const marker of backbone.markers) {
        expect(text, `${backbone.name} ${marker}`).toMatch(MARKER_EVIDENCE[marker]);
      }
    }
    for (const plasmid of plasmids) {
      expect(plasmid.accession).toMatch(/^[A-Z]{1,2}\d{5,6}\.\d+$/);
    }
  });

  it('counts only junctions between bases that no feature spans, including origin-wrapping ones', () => {
    expect(junctionsOutsideFeatures(10, [{ start: 3, end: 5 }])).toEqual([1, 2, 5, 6, 7, 8, 9]);
    expect(junctionsOutsideFeatures(10, [{ start: 8, end: 2 }])).toEqual([2, 3, 4, 5, 6, 7]);
  });
});
