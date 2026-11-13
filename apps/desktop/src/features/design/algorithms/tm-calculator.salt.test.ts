// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { calculateTmNN } from './tm-calculator';

const SEQ = 'GACCATGATTACGCCAAGCTT';

describe('calculateTmNN salt method', () => {
  it("default is unchanged and equals an explicit saltMethod: 'default'", () => {
    expect(calculateTmNN(SEQ)).toBe(calculateTmNN(SEQ, { saltMethod: 'default' }));
    expect(calculateTmNN(SEQ)).toBeCloseTo(55.3, 1);
  });

  it('owczarzy differs from default and Mg²⁺ raises the Tm', () => {
    const base = { naConc: 50, primerConc: 500 };
    const owNoMg = calculateTmNN(SEQ, { ...base, saltMethod: 'owczarzy', mgConc: 0 });
    const owMg = calculateTmNN(SEQ, { ...base, saltMethod: 'owczarzy', mgConc: 2 });
    const def = calculateTmNN(SEQ, { ...base, saltMethod: 'default' });

    expect(owNoMg).not.toBe(def);
    expect(owMg).toBeGreaterThan(owNoMg);
  });

  it('dNTP chelation lowers the owczarzy Tm (less free Mg²⁺)', () => {
    const base = { naConc: 50, primerConc: 500, saltMethod: 'owczarzy' as const, mgConc: 2 };
    const noDntp = calculateTmNN(SEQ, { ...base, dntpConc: 0 });
    const withDntp = calculateTmNN(SEQ, { ...base, dntpConc: 0.8 });
    expect(withDntp).toBeLessThan(noDntp);
  });
});
