export type OverhangType = 'blunt' | '5_prime' | '3_prime';

export type EnzymeType = 'Type_II' | 'Type_IIS' | 'Type_I' | 'Type_III' | 'Type_IV' | 'homing';

export interface EnzymeSupplier {
  code: string;
  name: string;
  catalog_number: string | null;
  product_url: string | null;
}

export interface RestrictionEnzyme {
  name: string;
  recognition_sequence: string;
  recognition_sequence_length: number;
  cut_position_top: number | null;
  cut_position_bottom: number | null;
  overhang_type: OverhangType | null;
  overhang_length: number | null;
  enzyme_type: EnzymeType;
  prototype: string | null;
  source_organism: string | null;
  methylation_site: string | null;
  methylation_sensitivity: string | null;
  optimal_temperature: number | null;
  heat_inactivation: number | null;
  suppliers: EnzymeSupplier[];
  rebase_id: string | null;
  isoschizomers: string[];
  neoschizomers: string[];
}

export interface CutSite {
  enzyme: RestrictionEnzyme;
  cutPositionTop: number;
  cutPositionBottom: number;
  cutPositionTopUnwrapped?: number;
  cutPositionBottomUnwrapped?: number;
  recognitionStart: number;
  recognitionEnd: number;
  strand: 'forward' | 'reverse';
  isInternalCutSite?: boolean;
}

export {
  INTERNAL_CUT_SITE_STYLE,
  internalCutSiteBadgeCanvasFont,
  internalCutSiteBadgeDomStyle,
  internalCutSiteBadgeFontSizePx,
  internalCutSiteBadgeRadiusPx,
} from './internal-cut-site-style';
export type { InternalCutSiteBadgeDomStyle } from './internal-cut-site-style';

export interface EnzymeDataFile {
  enzymes: RestrictionEnzyme[];
  supplier_codes: Record<string, { name: string; url: string | null }>;
  metadata: {
    version: string;
    generated_at: string;
    rebase_version: string | null;
    enzyme_count: number;
    commercially_available_count: number;
    sources: string[];
  };
}

export const VENDOR_CODES = {
  N: 'New England Biolabs',
  B: 'Thermo Fisher Scientific',
  K: 'Takara Bio Inc.',
  I: 'SibEnzyme Ltd.',
  R: 'Promega Corporation',
  S: 'Sigma Chemical Corporation',
  E: 'Agilent Technologies',
} as const;

export type VendorCode = keyof typeof VENDOR_CODES;

export type CutterFilter = 'single' | 'double' | 'single-double' | 'both' | 'none';

export interface ActiveEnzyme {
  enzyme: RestrictionEnzyme;
  cutCount: number;
  cutSites: CutSite[];
}

export { ENZYME_COLOR_PALETTE, enzymeColorHexAt as getEnzymeColor } from './enzyme-color-authority';

export interface ColoredCutSite extends CutSite {
  color: string;
}

export const MAX_CUT_SITES_ON_OVERVIEW = 200;
