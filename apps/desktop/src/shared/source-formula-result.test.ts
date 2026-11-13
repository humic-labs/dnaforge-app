// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  readSavedFormulaResult,
  isSourceFormulaMetadataValid,
  savedFormulaResultExplanation,
} from './source-formula-result';

const saved = {
  value: '42',
  type: 'text',
  sourceFormula: '=BENCHLING(A1)',
  sourceRenderedValue: '42',
  formulaCompatibility: 'unsupported',
  stale: false,
};

describe('saved source formula results', () => {
  it('reads legacy text cells and protocol-run formula cells including zero and empty results', () => {
    expect(readSavedFormulaResult(saved)).toEqual({
      formula: '=BENCHLING(A1)',
      value: '42',
      stale: false,
    });
    for (const computed of [0, '']) {
      expect(
        readSavedFormulaResult({
          type: 'formula',
          value: '=OTHER()',
          computed,
          formulaCompatibility: 'unsupported',
        })
      ).toEqual({ formula: '=OTHER()', value: String(computed), stale: false });
    }
    expect(
      readSavedFormulaResult({
        type: 'formula',
        value: '=OTHER()',
        formulaCompatibility: 'unsupported',
      })?.value
    ).toBeNull();
  });

  it('does not restore old source results over values edited by an older app', () => {
    const edited = { ...saved, value: '99' };
    expect(readSavedFormulaResult(edited)).toBeNull();
    expect(isSourceFormulaMetadataValid(edited)).toBe(true);
    expect(readSavedFormulaResult({ ...saved, value: '=1+1', type: 'formula' })).toBeNull();
  });

  it('leaves ordinary and supported native formulas alone', () => {
    expect(readSavedFormulaResult({ type: 'formula', value: '=1+1' })).toBeNull();
    expect(readSavedFormulaResult({ ...saved, formulaCompatibility: 'supported' })).toBeNull();
    expect(isSourceFormulaMetadataValid({ value: 'hello', type: 'text' })).toBe(true);
  });

  it.each([
    { sourceFormula: 42 },
    { sourceFormula: 'not a formula' },
    { sourceRenderedValue: 42 },
    { formulaCompatibility: 'unknown' },
    { stale: 'yes' },
  ])('rejects invalid provenance metadata %j', (metadata) => {
    expect(isSourceFormulaMetadataValid({ ...saved, ...metadata })).toBe(false);
  });

  it('explains the source formula and absence of a saved value without inventing a result', () => {
    expect(
      savedFormulaResultExplanation({ formula: '=OTHER()', value: null, stale: false })
    ).toContain('No result was saved in the source.');
  });
});
