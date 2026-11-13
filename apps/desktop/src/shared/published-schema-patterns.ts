const DNA_WITH_N = 'ACGTNacgtn';
const IUPAC_BASES = 'ACGTRYSWKMBDHVNacgtryswkmbdhvn';

export const DNA_WITH_N_PATTERN = new RegExp(`^[${DNA_WITH_N}]*$`);
export const IUPAC_BASES_PATTERN = new RegExp(`^[${IUPAC_BASES}]+$`);
export const OPTIONAL_IUPAC_BASES_PATTERN = new RegExp(`^[${IUPAC_BASES}]*$`);
export const CATALOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
