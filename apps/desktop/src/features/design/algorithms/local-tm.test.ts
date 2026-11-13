// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { localTmForModel } from './local-tm';
import { DEFAULT_TM_MODEL, OWCZARZY_TM_MODEL, DEFAULT_TM_CONDITIONS } from './tm-model';
import type { TmModel } from './tm-model';

const SEQ = 'ATCGATCGATCGATCGATCG';
const NEB_MODEL: TmModel = { kind: 'neb', prodcode: 'q5-0', polymerase: 'Q5' };

describe('localTmForModel', () => {
  it('returns null for sequences shorter than the minimum', () => {
    expect(localTmForModel('ATCG', DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500)).toBeNull();
  });

  it('computes a Tm for the default (SantaLucia) model', () => {
    const tm = localTmForModel(SEQ, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);
    expect(tm).not.toBeNull();
    expect(tm!).toBeGreaterThan(30);
    expect(tm!).toBeLessThan(90);
  });

  it('applies Owczarzy salt conditions (differs from the default salt path)', () => {
    const def = localTmForModel(SEQ, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500)!;
    const owc = localTmForModel(
      SEQ,
      OWCZARZY_TM_MODEL,
      { monovalentMm: 50, divalentMm: 3, dntpMm: 0.8 },
      500
    )!;
    expect(def).toBeGreaterThan(30);
    expect(owc).toBeGreaterThan(30);
    expect(owc).not.toBeCloseTo(def, 1);
  });

  it('a NEB model uses the LOCAL estimate here (never the API)', () => {
    const neb = localTmForModel(SEQ, NEB_MODEL, DEFAULT_TM_CONDITIONS, 500);
    const def = localTmForModel(SEQ, DEFAULT_TM_MODEL, DEFAULT_TM_CONDITIONS, 500);
    expect(def).toBeGreaterThan(30);
    expect(neb).toBe(def);
  });
});
