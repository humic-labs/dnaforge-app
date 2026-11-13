export interface SpeciesTaxon {
  speciesTaxid: string;
  speciesName: string;
}

export const LIMS_SPECIES_ROLLUP: Readonly<Record<string, SpeciesTaxon>> = {
  '511145': { speciesTaxid: '562', speciesName: 'Escherichia coli' },
  '316407': { speciesTaxid: '562', speciesName: 'Escherichia coli' },
  '562': { speciesTaxid: '562', speciesName: 'Escherichia coli' },
  '243277': { speciesTaxid: '666', speciesName: 'Vibrio cholerae' },
  '666': { speciesTaxid: '666', speciesName: 'Vibrio cholerae' },
  '559292': { speciesTaxid: '4932', speciesName: 'Saccharomyces cerevisiae' },
  '4932': { speciesTaxid: '4932', speciesName: 'Saccharomyces cerevisiae' },
};

export function rollUpToSpeciesTaxon(
  taxid: string | null | undefined,
  fallbackName?: string | null
): SpeciesTaxon | null {
  const trimmed = (taxid ?? '').trim();
  if (!trimmed) return null;
  const known = LIMS_SPECIES_ROLLUP[trimmed];
  if (known) return known;
  const name = (fallbackName ?? '').trim();
  return { speciesTaxid: trimmed, speciesName: name || `taxid:${trimmed}` };
}
