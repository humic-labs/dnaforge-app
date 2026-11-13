// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { owczarzySaltCorrectedTmC } from './tm-owczarzy';

const TM_1M = 65;
const FGC = 0.5;
const N = 20;

describe('owczarzySaltCorrectedTmC', () => {
  it('is a no-op at the 1 M Na⁺ reference (no Mg)', () => {
    const tm = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 1.0,
      divalentM: 0,
      dntpM: 0,
    });
    expect(tm).toBeCloseTo(TM_1M, 2);
  });

  it('lowers Tm below the 1 M reference at typical (50 mM Na⁺) salt', () => {
    const tm = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0,
      dntpM: 0,
    });
    expect(tm).toBeLessThan(TM_1M);
    expect(tm).toBeGreaterThan(TM_1M - 20);
  });

  it('raises Tm as monovalent concentration increases', () => {
    const low = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0,
      dntpM: 0,
    });
    const high = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.2,
      divalentM: 0,
      dntpM: 0,
    });
    expect(high).toBeGreaterThan(low);
  });

  it('Mg²⁺ stabilizes the duplex — raises Tm vs monovalent-only', () => {
    const monoOnly = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0,
      dntpM: 0,
    });
    const withMg = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0.002,
      dntpM: 0,
    });
    expect(withMg).toBeGreaterThan(monoOnly);
  });

  it('dNTP chelates Mg²⁺ — reduces free Mg²⁺, so Tm is lower than with no dNTP', () => {
    const noDntp = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0.002,
      dntpM: 0,
    });
    const withDntp = owczarzySaltCorrectedTmC(TM_1M, FGC, N, {
      monovalentM: 0.05,
      divalentM: 0.002,
      dntpM: 0.0008,
    });
    expect(withDntp).toBeLessThan(noDntp);
  });
});
