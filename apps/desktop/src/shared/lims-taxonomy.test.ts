// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { LIMS_SPECIES_ROLLUP, rollUpToSpeciesTaxon } from './lims-taxonomy';

describe('LIMS taxonomy species rollup', () => {
  it('rolls distinct K-12 strain taxids up to the same species (562)', () => {
    expect(rollUpToSpeciesTaxon('511145')).toEqual({
      speciesTaxid: '562',
      speciesName: 'Escherichia coli',
    });
    expect(rollUpToSpeciesTaxon('316407')).toEqual({
      speciesTaxid: '562',
      speciesName: 'Escherichia coli',
    });
  });

  it('treats a species-rank taxid as its own species (identity rollup)', () => {
    expect(rollUpToSpeciesTaxon('666')).toEqual({
      speciesTaxid: '666',
      speciesName: 'Vibrio cholerae',
    });
    expect(rollUpToSpeciesTaxon('4932')).toEqual({
      speciesTaxid: '4932',
      speciesName: 'Saccharomyces cerevisiae',
    });
  });

  it('returns null for an empty/missing taxid (entity has no organism)', () => {
    expect(rollUpToSpeciesTaxon(null)).toBeNull();
    expect(rollUpToSpeciesTaxon(undefined)).toBeNull();
    expect(rollUpToSpeciesTaxon('  ')).toBeNull();
  });

  it('falls back to a coarse identity rollup for an unknown taxid (so user data still groups)', () => {
    expect(rollUpToSpeciesTaxon('999999', 'Mystery sp.')).toEqual({
      speciesTaxid: '999999',
      speciesName: 'Mystery sp.',
    });
    expect(rollUpToSpeciesTaxon('888888')).toEqual({
      speciesTaxid: '888888',
      speciesName: 'taxid:888888',
    });
  });

  it('every committed rollup entry points at a real species anchor present in the map', () => {
    for (const taxon of Object.values(LIMS_SPECIES_ROLLUP)) {
      expect(LIMS_SPECIES_ROLLUP[taxon.speciesTaxid]?.speciesTaxid).toBe(taxon.speciesTaxid);
    }
  });
});
