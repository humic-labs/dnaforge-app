// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseGff3Line } from '@waypoint/genome-data';
import { resolveTranscripts } from './spliced-feature-resolver';
import { compactRawAnnotationsForTile } from '../../../main/ipc/genome-overview-tile-cache';
import {
  areMaterializedFixtureFiles,
  isCommandAvailable,
} from '../../../test/fixture-availability';

const GFF3_PATH = resolve(
  __dirname,
  '../../../../../../test-fixtures/.waypoint/genome-index/chr11-14q70ag/chr11.gff3.gz'
);
const SIRT3_REGION = 'chr11:215000-237000';
const TABIX = 'tabix';
const LIVE_SIRT3_FIXTURE_AVAILABLE =
  areMaterializedFixtureFiles([GFF3_PATH, `${GFF3_PATH}.tbi`]) && isCommandAvailable(TABIX);
const describeLiveSirt3 = LIVE_SIRT3_FIXTURE_AVAILABLE ? describe : describe.skip;
const EXPECTED_MRNA_17_BBOX_START = 215_029;
const EXPECTED_MRNA_17_BBOX_END = 236_931;
const SIRT3_GENE_END = 236_931;

function readSirt3Features() {
  const res = spawnSync(TABIX, [GFF3_PATH, SIRT3_REGION], {
    encoding: 'utf8',
    maxBuffer: 500 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`tabix failed: ${res.stderr}`);
  const features = [];
  for (const line of res.stdout.split('\n')) {
    const f = parseGff3Line(line);
    if (f) features.push(f);
  }
  return features;
}

function findMrna17(resolved) {
  for (const a of resolved) {
    if ('transcripts' in a && Array.isArray(a.transcripts)) {
      const found = a.transcripts.find((t) => t.transcriptId === 'SIRT3.mrna.17');
      if (found) return found;
    }
    if ('transcriptId' in a && a.transcriptId === 'SIRT3.mrna.17' && Array.isArray(a.exons)) {
      return a;
    }
  }
  return null;
}

describeLiveSirt3(' SIRT3.mrna.17 — isolating resolver-vs-compactor corruption', () => {
  it('resolveTranscripts directly: SIRT3.mrna.17 keeps its own bbox, exons, and own CDS', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const features = readSirt3Features();
      expect(features.length, 'tabix returned no features').toBeGreaterThan(200);

      const sirt3Mrna17Source = features.find(
        (f) => f.type === 'mRNA' && f.attributes.ID?.[0] === 'SIRT3.mrna.17'
      );
      expect(sirt3Mrna17Source, 'source SIRT3.mrna.17 not found in tabix output').toBeDefined();

      const sirt3OwnCdsSource = features.filter(
        (f) => f.type === 'CDS' && f.attributes.Parent?.[0] === 'SIRT3.mrna.17'
      );
      const sirt3OwnExonSource = features.filter(
        (f) => f.type === 'exon' && f.attributes.Parent?.[0] === 'SIRT3.mrna.17'
      );
      console.log(
        `[live GFF3] SIRT3.mrna.17: ${sirt3OwnExonSource.length} own exons, ${sirt3OwnCdsSource.length} own CDS records via Parent= linking`
      );
      console.log(
        `[live GFF3] mrna.17 source own CDS bp ranges:`,
        sirt3OwnCdsSource.map((c) => [c.start + 1, c.end])
      );

      const resolved = resolveTranscripts(features);
      const mrna17 = findMrna17(resolved);
      expect(mrna17, 'SIRT3.mrna.17 missing from resolveTranscripts output').not.toBeNull();
      if (!mrna17) return;

      console.log(
        `[resolveTranscripts output] mrna.17 bbox=${mrna17.start}-${mrna17.end}, exons=${mrna17.exons.length}, cds=${mrna17.cds.length}`
      );
      console.log(`[resolveTranscripts output] mrna.17 cds:`, JSON.stringify(mrna17.cds));

      expect(mrna17.start).toBe(EXPECTED_MRNA_17_BBOX_START);
      expect(mrna17.end).toBe(EXPECTED_MRNA_17_BBOX_END);
      expect(mrna17.exons.length).toBe(sirt3OwnExonSource.length);
      expect(mrna17.cds.length).toBe(sirt3OwnCdsSource.length);

      const segs = [...mrna17.cds].sort((a, b) => a.start - b.start);
      for (let i = 0; i < segs.length - 1; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          expect(
            segs[i].end <= segs[j].start,
            `mrna.17 has overlapping CDS: ${JSON.stringify(segs[i])} and ${JSON.stringify(segs[j])}`
          ).toBe(true);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('compactRawAnnotationsForTile (compactor): preserves SIRT3.mrna.17 shape', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const features = readSirt3Features();
      const compacted = compactRawAnnotationsForTile(features);
      const mrna17 = findMrna17(compacted);
      expect(mrna17, 'SIRT3.mrna.17 missing from compactor output').not.toBeNull();
      if (!mrna17) return;
      expect(mrna17.start).toBe(EXPECTED_MRNA_17_BBOX_START);
      expect(mrna17.end).toBe(EXPECTED_MRNA_17_BBOX_END);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
