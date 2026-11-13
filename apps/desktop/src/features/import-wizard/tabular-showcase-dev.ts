import strainsCsv from '../lims/__fixtures__/strains-34.csv?raw';
import { platform } from '../../platform';
import { normalizeInlineDnaSequenceRef } from '../../shared/lims';
import { runTabularImportFlow } from './run-tabular-import-flow';

export const STRAINS_SHOWCASE_CSV = strainsCsv;
const SHOWCASE_PLASMIDS = ['pUC19', 'pET28a', 'pACYC184', 'pRS416'];

export async function seedTabularShowcaseRegistry(): Promise<void> {
  const lims = platform().lims;
  await lims.resetRegistry();
  for (const name of SHOWCASE_PLASMIDS) {
    await lims.registerEntity({
      kind: 'plasmid',
      name,
      fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
    });
  }
}

export async function runTabularShowcase(): Promise<void> {
  await seedTabularShowcaseRegistry();
  await runTabularImportFlow([{ name: 'strains.csv', text: STRAINS_SHOWCASE_CSV }]);
}
