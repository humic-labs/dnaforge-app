import REAL_PUC19_GENBANK from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import { createPuc19Sequence } from './sequence-data';

export { MINI_PLASMID, GFP_LINEAR, GFP_FASTA } from './sequence-data';

export const PUC19 = createPuc19Sequence(REAL_PUC19_GENBANK);
export const PUC19_GENBANK = REAL_PUC19_GENBANK;
