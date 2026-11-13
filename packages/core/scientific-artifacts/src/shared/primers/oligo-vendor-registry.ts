import {
  IDT_CATALOG_SNAPSHOT,
  type IdtCatalogSnapshotEntry,
} from './vendor-data/idt-modification-catalog';
import type { OligoOrderType } from './oligo-order-type';

export { IDT_CATALOG_SNAPSHOT } from './vendor-data/idt-modification-catalog';

export type OligoModificationPlacement = 'five-prime' | 'internal' | 'three-prime';
export type OligoNaturalBase = 'A' | 'C' | 'G' | 'T' | 'U' | 'N';
export type OligoModificationCategory =
  | 'attachment'
  | 'fluorophore'
  | 'modified-base'
  | 'quencher'
  | 'spacer'
  | 'linkage'
  | 'other';
export type OligoModificationBehavior =
  | 'terminal-attachment'
  | 'between-bases'
  | 'modified-base'
  | 'linkage';

export interface OligoModificationVendorMetadata {
  productId: number;
  categoryId: number | null;
  categoryLabel: string | null;
  extinctionCoefficient: number;
  molecularWeight: number;
  requiresHplc: boolean;
  requiresIeHplc: boolean;
  allowsPage: boolean;
  requiresRnaseFree: boolean;
}

export interface OligoModificationCatalogEntry {
  chemistryId: string;
  label: string;
  category: OligoModificationCategory;
  vendor: 'idt';
  vendorCode: string;

  supportedOrderTypes: readonly OligoOrderType[];

  notation: string;
  placement: OligoModificationPlacement;

  allowedPlacements?: readonly OligoModificationPlacement[];
  behavior: OligoModificationBehavior;

  naturalBase?: OligoNaturalBase;
  searchTerms?: readonly string[];
  productUrl?: string;
  vendorMetadata?: OligoModificationVendorMetadata;
}

export interface OligoVendorMaxConsecutiveRule {
  id: string;
  kind: 'max-consecutive';
  enforcement: 'hard';
  chemistryId: string;
  maximum: number;
  severity: 'error';
  message: string;
  sourceUrl: string;
}

export interface OligoVendorDocumentedAdjacentSeriesRule {
  id: string;
  kind: 'documented-adjacent-series';
  enforcement: 'informational';
  chemistryId: string;
  minimumDocumented: number;
  maximumDocumented: number;
  severity: 'warning';
  message: string;
  sourceUrl: string;
}

export interface OligoVendorContextualMaxConsecutiveRule {
  id: string;
  kind: 'contextual-max-consecutive';
  enforcement: 'hard';
  chemistryId: string;
  maximum: number;
  appliesWhen: {
    adjacentChemistryId: string;
    terminalPlacements: readonly ('five-prime' | 'three-prime')[];
  };
  severity: 'error';
  message: string;
  sourceUrl: string;
}

export type OligoVendorProductClass = 'dna-rna-oligo' | 'qpcr-probe';

export interface OligoVendorMaxTotalRule {
  id: string;
  kind: 'max-total';
  enforcement: 'hard';
  chemistryIds: readonly string[];
  maximum: number;
  productClasses: readonly OligoVendorProductClass[];
  severity: 'error';
  message: string;
  sourceUrl: string;
}

export interface OligoVendorIncompatibleChemistriesRule {
  id: string;
  kind: 'incompatible-chemistries';
  enforcement: 'hard';
  leftChemistryIds: readonly string[];
  rightChemistryIds: readonly string[];
  severity: 'error';
  message: string;
  sourceUrl: string;
}

export interface OligoVendorRequiresCompanionRule {
  id: string;
  kind: 'requires-companion';
  enforcement: 'hard';
  triggerChemistryIds: readonly string[];
  requiredAnyOf: readonly {
    chemistryId: string;
    placement?: OligoModificationPlacement;
  }[];
  severity: 'error';
  message: string;
  sourceUrl: string;
}

export type OligoVendorRule =
  | OligoVendorMaxConsecutiveRule
  | OligoVendorDocumentedAdjacentSeriesRule
  | OligoVendorContextualMaxConsecutiveRule
  | OligoVendorMaxTotalRule
  | OligoVendorIncompatibleChemistriesRule
  | OligoVendorRequiresCompanionRule;

export interface OligoVendorDefinition {
  id: 'idt';
  label: string;
  notation: string;
  catalogBrowseUrl: string;
  catalogSourceUrl?: string;
  catalogRetrievedAt?: string;
  catalog: readonly OligoModificationCatalogEntry[];
  rules: readonly OligoVendorRule[];
}

type LegacySemantics = Pick<OligoModificationCatalogEntry, 'chemistryId' | 'label'>;

const LEGACY_SEMANTICS_BY_CODE: Readonly<Record<string, LegacySemantics>> = {
  '5Phos': { chemistryId: 'phosphorylation', label: '5′ phosphorylation' },
  '3Phos': { chemistryId: 'phosphorylation', label: '3′ phosphorylation' },
  '5Sp18': { chemistryId: 'spacer-18', label: '5′ Spacer 18' },
  iSp18: { chemistryId: 'spacer-18', label: 'Internal Spacer 18' },
  '3Sp18': { chemistryId: 'spacer-18', label: '3′ Spacer 18' },
  '5SpC3': { chemistryId: 'spacer-c3', label: '5′ Spacer C3' },
  iSpC3: { chemistryId: 'spacer-c3', label: 'Internal Spacer C3' },
  '3SpC3': { chemistryId: 'spacer-c3', label: '3′ Spacer C3' },
  '5AmMC6': { chemistryId: 'amino-modifier-c6', label: '5′ Amino Modifier C6' },
  iAmMC6T: { chemistryId: 'amino-modifier-c6-dt', label: 'Internal Amino Modifier C6-dT' },
  '3AmMC6T': { chemistryId: 'amino-modifier-c6-dt', label: '3′ Amino Modifier C6-dT' },
  '5BiodT': { chemistryId: 'biotin-dt', label: '5′ Biotin-dT' },
  iBiodT: { chemistryId: 'biotin-dt', label: 'Internal Biotin-dT' },
  '3BiodT': { chemistryId: 'biotin-dt', label: '3′ Biotin-dT' },
  '5Me-dC': { chemistryId: '5-methyl-dc', label: '5′ 5-Methyl-dC' },
  'iMe-dC': { chemistryId: '5-methyl-dc', label: 'Internal 5-Methyl-dC' },
  '3Me-dC': { chemistryId: '5-methyl-dc', label: '3′ 5-Methyl-dC' },
  '3InvdT': { chemistryId: 'inverted-dt', label: '3′ Inverted dT' },
  '56-FAM': { chemistryId: 'fam', label: '5′ 6-FAM' },
  '36-FAM': { chemistryId: 'fam', label: '3′ 6-FAM' },
  '5Cy3': { chemistryId: 'cy3', label: '5′ Cy3' },
  iCy3: { chemistryId: 'cy3', label: 'Internal Cy3' },
  '3Cy3Sp': { chemistryId: 'cy3', label: '3′ Cy3' },
  '5DTPA': { chemistryId: 'dithiol-dtpa', label: '5′ Dithiol' },
  iDTPA: { chemistryId: 'dithiol-dtpa', label: 'Internal Dithiol' },
  '3DTPA': { chemistryId: 'dithiol-dtpa', label: '3′ Dithiol' },
};

const NATURAL_BASE_BY_CODE: Readonly<Record<string, OligoNaturalBase>> = {
  '55NitInd': 'N',
  '5BiodT': 'T',
  '55Br-dU': 'U',
  '5Me-dC': 'C',
  '5FluorT': 'T',
  '5dSp': 'N',
  '5AmdA': 'A',
  '5deoxyI': 'N',
  '5deoxyU': 'U',
  '5AmMC6T': 'T',
  '52AmPr': 'A',
  '5Me-isodC': 'C',
  '5isodG': 'G',
  '52FU': 'U',
  '52FC': 'C',
  '52FA': 'A',
  '52FG': 'G',
  '5InvddT': 'T',
  '55OctdU': 'U',
  '55HydMe-dC': 'C',
  '5Super-dT': 'T',
  '5Super-dG': 'G',
  '52MOErA': 'A',
  '52MOErC': 'C',
  '52MOErG': 'G',
  '52MOErT': 'T',
  ideoxyI: 'N',
  ideoxyU: 'U',
  'iMe-dC': 'C',
  iBiodT: 'T',
  iFluorT: 'T',
  i2AmPr: 'A',
  i6diPr: 'A',
  idSp: 'N',
  iAmMC6T: 'T',
  'i5Br-dU': 'U',
  i5NitInd: 'N',
  i8oxodG: 'G',
  'iN6Me-dA': 'A',
  'iMe-isodC': 'C',
  iisodG: 'G',
  i2FU: 'U',
  i2FC: 'C',
  'iBHQ-1dT': 'T',
  'iBHQ-2dT': 'T',
  i2FA: 'A',
  i2FG: 'G',
  i5OctdU: 'U',
  'i5HydMe-dC': 'C',
  iBiodUK: 'T',
  iRiboI: 'N',
  'iSuper-dG': 'G',
  'iSuper-dT': 'T',
  'iN6Me-rA': 'A',
  i2MOErA: 'A',
  i2MOErC: 'C',
  i2MOErG: 'G',
  i2MOErT: 'T',
  '3deoxyU': 'U',
  '3ddC': 'C',
  '3InvdT': 'T',
  '3Me-dC': 'C',
  '35NitInd': 'N',
  '3AmdA': 'A',
  '32AmPu': 'A',
  '32FC': 'C',
  '32FU': 'U',
  '32FA': 'A',
  '32FG': 'G',
  '3FluorT': 'T',
  '3BiodT': 'T',
  '3AmMC6T': 'T',
  '3dSp': 'N',
  '35OctdU': 'U',
  '35HydMe-dC': 'C',
  '3Super-dG': 'G',
  '3Super-dT': 'T',
  '32MOErA': 'A',
  '32MOErC': 'C',
  '32MOErG': 'G',
  '32MOErT': 'T',
};

const COMMON_CODE_ORDER = Object.keys(LEGACY_SEMANTICS_BY_CODE);
const COMMON_CODE_RANK = new Map(COMMON_CODE_ORDER.map((code, index) => [code, index]));

const IDT_CLICK_CHEMISTRY_CODES = new Set([
  '5Hexynyl',
  '55OctdU',
  'i5OctdU',
  '35OctdU',
  '5AzideN',
  'iAzideN',
  '3AzideN',
  '5DBCOTEG',
  '5DBCON',
  '3DBCON',
]);

function categoryFor(entry: IdtCatalogSnapshotEntry): OligoModificationCategory {
  if (entry.categoryId === 3) return 'fluorophore';
  if (entry.categoryId === 4 || entry.categoryId === 5) return 'quencher';
  if (entry.categoryId === 6) return 'spacer';
  if (entry.categoryId === 7) return 'modified-base';
  if (entry.categoryId === 1 || entry.categoryId === 2) return 'attachment';
  return 'other';
}

function displayLabel(entry: IdtCatalogSnapshotEntry): string {
  const legacy = LEGACY_SEMANTICS_BY_CODE[entry.vendorCode];
  if (legacy) return legacy.label;
  return entry.label
    .replace(/^5'\s+/, '5′ ')
    .replace(/^3'\s+/, '3′ ')
    .replace(/^Int\s+/, 'Internal ');
}

function chemistryId(entry: IdtCatalogSnapshotEntry): string {
  const legacy = LEGACY_SEMANTICS_BY_CODE[entry.vendorCode];
  if (legacy) return legacy.chemistryId;
  if (entry.vendorCode === '5DBCOTEG') return 'dbco-teg';
  if (entry.vendorCode === '5DBCON') return 'dbco-n';
  const withoutPlacement = entry.label.replace(/^(?:5'|3'|Int)\s+/, '');
  const slug = withoutPlacement
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || `idt-product-${entry.productId}`;
}

function catalogEntry(entry: IdtCatalogSnapshotEntry): OligoModificationCatalogEntry {
  const naturalBase = NATURAL_BASE_BY_CODE[entry.vendorCode];
  if (entry.categoryId === 7 && entry.vendorCode !== '3Puro' && !naturalBase) {
    throw new Error(
      `IDT modified-base ${entry.vendorCode} needs an explicit natural-base projection.`
    );
  }
  const behavior: OligoModificationBehavior = naturalBase
    ? 'modified-base'
    : entry.placement === 'internal'
      ? 'between-bases'
      : 'terminal-attachment';
  const searchTerms = [entry.categoryLabel].filter((term): term is string => Boolean(term));
  return {
    chemistryId: chemistryId(entry),
    label: displayLabel(entry),
    category: categoryFor(entry),
    vendor: 'idt',
    vendorCode: entry.vendorCode,
    supportedOrderTypes: entry.supportedOrderTypes,
    notation: `/${entry.vendorCode}/`,
    placement: entry.placement,
    behavior,
    ...(naturalBase ? { naturalBase } : {}),
    ...(searchTerms.length > 0 ? { searchTerms } : {}),
    productUrl: entry.productUrl,
    vendorMetadata: {
      productId: entry.productId,
      categoryId: entry.categoryId,
      categoryLabel: entry.categoryLabel,
      extinctionCoefficient: entry.extinctionCoefficient,
      molecularWeight: entry.molecularWeight,
      requiresHplc: entry.requiresHplc,
      requiresIeHplc: entry.requiresIeHplc,
      allowsPage: entry.allowsPage,
      requiresRnaseFree: entry.requiresRnaseFree,
    },
  };
}

const officialCatalog = IDT_CATALOG_SNAPSHOT.entries
  .map((entry, sourceIndex) => ({ entry, sourceIndex }))
  .sort((left, right) => {
    const leftRank = COMMON_CODE_RANK.get(left.entry.vendorCode);
    const rightRank = COMMON_CODE_RANK.get(right.entry.vendorCode);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return left.sourceIndex - right.sourceIndex;
  })
  .map(({ entry }) => catalogEntry(entry));

export const IDT_MODIFICATION_CATALOG: readonly OligoModificationCatalogEntry[] = [
  ...officialCatalog,
  ...(['A', 'C', 'G', 'T'] as const).map(
    (base): OligoModificationCatalogEntry => ({
      chemistryId: `affinity-plus-${base.toLowerCase()}`,
      label: `Affinity Plus ${base}`,
      category: 'modified-base',
      vendor: 'idt',
      vendorCode: `+${base}`,
      supportedOrderTypes: ['dna', 'rna'],
      notation: `+${base}`,
      placement: 'internal',
      allowedPlacements: ['five-prime', 'internal', 'three-prime'],
      behavior: 'modified-base',
      naturalBase: base,
      searchTerms: ['Affinity Plus', 'locked nucleic acid', 'LNA', 'Modified Bases'],
      productUrl: 'https://www.idtdna.com/site/Catalog/Modifications/Category/7',
    })
  ),
  {
    chemistryId: 'phosphorothioate',
    label: 'Phosphorothioate bond',
    category: 'linkage',
    vendor: 'idt',
    vendorCode: '*',
    supportedOrderTypes: ['dna', 'rna'],
    notation: '*',
    placement: 'internal',
    behavior: 'linkage',
    searchTerms: ['PS bond', 'sulfur'],
    productUrl: 'https://www.idtdna.com/site/Catalog/Modifications/Category/8',
  },
];

export const IDT_VENDOR_DEFINITION: OligoVendorDefinition = {
  id: 'idt',
  label: 'Integrated DNA Technologies',
  notation:
    'Slash-delimited modification codes; Affinity Plus bases use +A/+C/+G/+T; phosphorothioate bonds use *.',
  catalogBrowseUrl: 'https://www.idtdna.com/site/catalog/modifications',
  catalogSourceUrl: IDT_CATALOG_SNAPSHOT.sourceUrl,
  catalogRetrievedAt: IDT_CATALOG_SNAPSHOT.retrievedAt,
  catalog: IDT_MODIFICATION_CATALOG,
  rules: [
    {
      id: 'idt-dtpa-documented-adjacent-series',
      kind: 'documented-adjacent-series',
      enforcement: 'informational',
      chemistryId: 'dithiol-dtpa',
      minimumDocumented: 2,
      maximumDocumented: 3,
      severity: 'warning',
      message:
        'IDT documents adjacent DTPA series of 2 or 3; this is guidance, not a published hard maximum.',
      sourceUrl:
        'https://www.idtdna.com/page/support-and-education/decoded-plus/choosing-the-right-mod-for-your-needs/',
    },
    {
      id: 'idt-terminal-biotin-spacer18-max-consecutive',
      kind: 'contextual-max-consecutive',
      enforcement: 'hard',
      chemistryId: 'spacer-18',
      maximum: 3,
      appliesWhen: {
        adjacentChemistryId: 'biotin-teg',
        terminalPlacements: ['five-prime', 'three-prime'],
      },
      severity: 'error',
      message:
        'IDT allows up to 3 Spacer 18 modifications between a terminal biotin and the oligo sequence.',
      sourceUrl:
        'https://www3.idtdna.com/pages/support/faqs/what-is-the-length-of-the-teg-spacer-in-your-biotin-teg-modification-and-do-you-offer-a-longer-spacer-arm-than-teg-',
    },
    {
      id: 'idt-yakima-yellow-tamra-incompatible',
      kind: 'incompatible-chemistries',
      enforcement: 'hard',
      leftChemistryIds: ['yakima-yellow'],
      rightChemistryIds: ['tamratm', 'tamra-nhs-ester', '5-tamratm-azide'],
      severity: 'error',
      message: 'IDT does not allow Yakima Yellow and TAMRA in the same oligo.',
      sourceUrl: 'https://www.idtdna.com/site/catalog/modifications/category/3',
    },
    {
      id: 'idt-adenylation-requires-three-prime-block',
      kind: 'requires-companion',
      enforcement: 'hard',
      triggerChemistryIds: ['adenylation'],
      requiredAnyOf: [
        { chemistryId: 'spacer-c3', placement: 'three-prime' },
        { chemistryId: 'dideoxy-c', placement: 'three-prime' },
      ],
      severity: 'error',
      message:
        'IDT requires a 3′ blocking group on an adenylated oligo; use 3′ Spacer C3 or Dideoxy-C.',
      sourceUrl: 'https://www.idtdna.com/site/catalog/modifications/product/2342',
    },
    {
      id: 'idt-affinity-plus-oligo-max-total',
      kind: 'max-total',
      enforcement: 'hard',
      chemistryIds: ['affinity-plus-a', 'affinity-plus-c', 'affinity-plus-g', 'affinity-plus-t'],
      maximum: 20,
      productClasses: ['dna-rna-oligo'],
      severity: 'error',
      message: 'IDT allows at most 20 Affinity Plus bases in a DNA or RNA oligo.',
      sourceUrl: 'https://www.idtdna.com/site/Catalog/Modifications/Category/7',
    },
    {
      id: 'idt-affinity-plus-qpcr-max-total',
      kind: 'max-total',
      enforcement: 'hard',
      chemistryIds: ['affinity-plus-a', 'affinity-plus-c', 'affinity-plus-g', 'affinity-plus-t'],
      maximum: 6,
      productClasses: ['qpcr-probe'],
      severity: 'error',
      message: 'IDT allows at most 6 Affinity Plus bases in an Affinity Plus qPCR probe.',
      sourceUrl: 'https://www.idtdna.com/site/Catalog/Modifications/Category/7',
    },
  ],
};

export function idtModificationPlacements(
  entry: OligoModificationCatalogEntry
): readonly OligoModificationPlacement[] {
  return entry.allowedPlacements ?? [entry.placement];
}

export function idtModificationCategoryLabel(entry: OligoModificationCatalogEntry): string {
  if (entry.vendorMetadata?.categoryLabel) return entry.vendorMetadata.categoryLabel;
  if (entry.vendorCode === '*') return 'Phosphorothioate Bonds';
  if (entry.vendorCode.startsWith('+')) return 'Modified Bases';
  return 'Other IDT entries';
}

export function idtModificationCategoryLabels(
  entry: OligoModificationCatalogEntry
): readonly string[] {
  const primary = idtModificationCategoryLabel(entry);
  return IDT_CLICK_CHEMISTRY_CODES.has(entry.vendorCode) ? [primary, 'Click Chemistry'] : [primary];
}

const IDT_CATEGORY_LABEL_ORDER = [
  'Phosphorylation',
  'Attachment Chemistry / Linkers',
  'Fluorophores',
  'Iowa Black® Dark Quenchers',
  'Dark Quenchers',
  'Spacers',
  'Modified Bases',
  'Phosphorothioate Bonds',
  'Click Chemistry',
  'Other IDT entries',
] as const;

export function idtModificationSupportsOrderType(
  entry: OligoModificationCatalogEntry,
  orderType: OligoOrderType
): boolean {
  return entry.supportedOrderTypes.includes(orderType);
}

export function idtModificationNaturalBase(
  entry: OligoModificationCatalogEntry,
  orderType: OligoOrderType
): OligoNaturalBase | undefined {
  if (entry.naturalBase === 'U' && orderType === 'dna') return 'T';
  return entry.naturalBase;
}

export function idtModificationCategoryFilters(
  orderType: OligoOrderType
): readonly { label: string; count: number }[] {
  return IDT_CATEGORY_LABEL_ORDER.flatMap((label) => {
    const count = IDT_MODIFICATION_CATALOG.filter(
      (entry) =>
        idtModificationSupportsOrderType(entry, orderType) &&
        idtModificationCategoryLabels(entry).includes(label)
    ).length;
    return count > 0 ? [{ label, count }] : [];
  });
}

export const OLIGO_VENDOR_REGISTRY: Readonly<Record<string, OligoVendorDefinition>> = {
  idt: IDT_VENDOR_DEFINITION,
};
