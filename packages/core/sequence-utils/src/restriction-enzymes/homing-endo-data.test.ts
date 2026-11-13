import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { EnzymeDataFile, RestrictionEnzyme } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_FILES = [
  'apps/desktop/public/data/rebase/merged-enzymes.json',
  'apps/desktop/public/data/rebase/neb-enzymes.json',
  'apps/desktop/public/data/rebase/thermofisher-enzymes.json',
];

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

function loadFile(rel: string): EnzymeDataFile {
  const text = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
  return JSON.parse(text) as EnzymeDataFile;
}

describe('homing endonuclease data invariant', () => {
  for (const rel of DATA_FILES) {
    describe(rel, () => {
      const file = loadFile(rel);
      const homing = file.enzymes.filter((e) => e.enzyme_type === 'homing');

      it('contains at least one homing endonuclease', () => {
        expect(homing.length).toBeGreaterThan(0);
      });

      it.each(homing.map((e) => [e.name, e]))(
        '%s has a non-null recognition sequence',
        (_name, enzyme) => {
          const e = enzyme as RestrictionEnzyme;
          expect(e.recognition_sequence).not.toBeNull();
          expect(e.recognition_sequence_length).not.toBeNull();
          expect(e.recognition_sequence!.length).toBe(e.recognition_sequence_length);
          expect(e.recognition_sequence!).toMatch(/^[ACGTRYMKSWHBVDNU]+$/i);
        }
      );

      it.each(homing.map((e) => [e.name, e]))(
        '%s has cut positions inside the recognition window',
        (_name, enzyme) => {
          const e = enzyme as RestrictionEnzyme;
          expect(e.cut_position_top).not.toBeNull();
          expect(e.cut_position_bottom).not.toBeNull();
          expect(e.cut_position_top!).toBeGreaterThanOrEqual(0);
          expect(e.cut_position_bottom!).toBeGreaterThanOrEqual(0);
          expect(e.cut_position_top!).toBeLessThanOrEqual(e.recognition_sequence_length!);
          expect(e.cut_position_bottom!).toBeLessThanOrEqual(e.recognition_sequence_length!);
        }
      );
    });
  }
});
