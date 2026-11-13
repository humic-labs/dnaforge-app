// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  primerIdtOrderText,
  primerNaturalBasesText,
  writePrimerNaturalBasesClipboard,
} from './primer-clipboard';

describe('primer clipboard serialization', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it('uses the shared parser to copy modification-free biological bases', () => {
    const notation = '/5Phos/ACG/iBiodT//iSp18/G/3InvdT/';
    expect(primerNaturalBasesText(notation)).toBe('ACGTGT');
  });

  it('refuses to copy invalid vendor notation as valid biological bases', async () => {
    expect(() => primerNaturalBasesText('ACGT/unknown/')).toThrow(/Unknown IDT modification/);
    await expect(writePrimerNaturalBasesClipboard('ACGT/unknown/')).rejects.toThrow(
      /Unknown IDT modification/
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('writes the selected representation to the operating-system clipboard', async () => {
    await writePrimerNaturalBasesClipboard('/5Phos/ACGTACGTACGT');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ACGTACGTACGT');
  });

  it('emits compact IDT-ready notation and refuses a sequence mismatch', () => {
    expect(primerIdtOrderText('ACGT', ' /5Phos/ ACGT /3SpC3/ ')).toBe('/5Phos/ACGT/3SpC3/');
    expect(primerIdtOrderText('ACGT', '+A+C+G+T')).toBe('+A+C+G+T');
    expect(() => primerIdtOrderText('AAAA', '/5Phos/ACGT')).toThrow(
      /do not match the primer sequence/
    );
    expect(() => primerIdtOrderText('AC', '/5YakYel/AC/36-TAMSp/')).toThrow(
      /does not allow Yakima Yellow and TAMRA/
    );
  });

  it('preserves exact IDT RNA order text and copies natural T/U identities without DNA normalization', () => {
    const notation = '/5Phos/rA*rCmG/i2FU/rC/3SpC3/';
    expect(primerIdtOrderText('ACGUC', notation, 'rna')).toBe(notation);
    expect(primerNaturalBasesText(notation, 'rna')).toBe('ACGUC');
    expect(primerNaturalBasesText('ArCrGTrU', 'rna')).toBe('ACGTU');
    expect(primerNaturalBasesText('A/i2FU/C', 'dna')).toBe('ATC');
  });

  it('serializes plain RNA editor bases into IDT RNA order notation', () => {
    expect(primerIdtOrderText('ACGU', null, 'rna')).toBe('rArCrGrU');
    expect(primerIdtOrderText('MRGU', null, 'rna')).toBe('rMrRrGrU');
    expect(primerIdtOrderText('ACGTU', 'ACGTrU', 'rna')).toBe('ACGTrU');
    expect(primerIdtOrderText('aCgU', null, 'rna')).toBe('rarCrgrU');
    expect(primerNaturalBasesText('rarCrgrU', 'rna')).toBe('aCgU');
  });
});
