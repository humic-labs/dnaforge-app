import rawSnapshot from './idt-modification-catalog.snapshot.json';
import type { OligoOrderType } from '../oligo-order-type';

export type IdtCatalogPlacement = 'five-prime' | 'internal' | 'three-prime';

export interface IdtCatalogSnapshotEntry {
  productId: number;
  vendorCode: string;
  placement: IdtCatalogPlacement;
  extinctionCoefficient: number;
  molecularWeight: number;
  requiresHplc: boolean;
  requiresIeHplc: boolean;
  allowsPage: boolean;
  requiresRnaseFree: boolean;
  supportedOrderTypes: readonly OligoOrderType[];
  label: string;
  categoryId: number | null;
  categoryLabel: string | null;
  productUrl: string;
}

export interface IdtCatalogSnapshot {
  schemaVersion: 2;
  vendor: 'idt';
  retrievedAt: string;
  sourceUrl: string;
  availabilitySources: readonly {
    orderType: OligoOrderType;
    productInfoUrl: string;
    productModificationsUrlTemplate: string;
    productIds: readonly number[];
  }[];
  officialSlashCodeCount: number;
  entries: IdtCatalogSnapshotEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function parseOrderTypes(value: unknown): OligoOrderType[] {
  if (
    !Array.isArray(value) ||
    value.some((orderType) => orderType !== 'dna' && orderType !== 'rna') ||
    new Set(value).size !== value.length
  ) {
    throw new Error('The checked-in IDT modification catalog contains invalid order types.');
  }
  return [...value];
}

function parseEntry(value: unknown): IdtCatalogSnapshotEntry {
  if (
    !isRecord(value) ||
    typeof value.productId !== 'number' ||
    typeof value.vendorCode !== 'string' ||
    (value.placement !== 'five-prime' &&
      value.placement !== 'internal' &&
      value.placement !== 'three-prime') ||
    typeof value.extinctionCoefficient !== 'number' ||
    typeof value.molecularWeight !== 'number' ||
    typeof value.requiresHplc !== 'boolean' ||
    typeof value.requiresIeHplc !== 'boolean' ||
    typeof value.allowsPage !== 'boolean' ||
    typeof value.requiresRnaseFree !== 'boolean' ||
    !Array.isArray(value.supportedOrderTypes) ||
    typeof value.label !== 'string' ||
    !nullableNumber(value.categoryId) ||
    !nullableString(value.categoryLabel) ||
    typeof value.productUrl !== 'string'
  ) {
    throw new Error('The checked-in IDT modification catalog contains an invalid row.');
  }
  return {
    productId: value.productId,
    vendorCode: value.vendorCode,
    placement: value.placement,
    extinctionCoefficient: value.extinctionCoefficient,
    molecularWeight: value.molecularWeight,
    requiresHplc: value.requiresHplc,
    requiresIeHplc: value.requiresIeHplc,
    allowsPage: value.allowsPage,
    requiresRnaseFree: value.requiresRnaseFree,
    supportedOrderTypes: parseOrderTypes(value.supportedOrderTypes),
    label: value.label,
    categoryId: value.categoryId,
    categoryLabel: value.categoryLabel,
    productUrl: value.productUrl,
  };
}

function parseSnapshot(value: unknown): IdtCatalogSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.vendor !== 'idt' ||
    typeof value.retrievedAt !== 'string' ||
    typeof value.sourceUrl !== 'string' ||
    !Array.isArray(value.availabilitySources) ||
    typeof value.officialSlashCodeCount !== 'number' ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('The checked-in IDT modification catalog metadata is invalid.');
  }
  const availabilitySources = value.availabilitySources.map((source) => {
    if (
      !isRecord(source) ||
      (source.orderType !== 'dna' && source.orderType !== 'rna') ||
      typeof source.productInfoUrl !== 'string' ||
      typeof source.productModificationsUrlTemplate !== 'string' ||
      !Array.isArray(source.productIds) ||
      source.productIds.some((productId) => typeof productId !== 'number')
    ) {
      throw new Error('The checked-in IDT availability provenance is invalid.');
    }
    const orderType: OligoOrderType = source.orderType;
    const productIds = source.productIds.filter(
      (productId): productId is number => typeof productId === 'number'
    );
    return {
      orderType,
      productInfoUrl: source.productInfoUrl,
      productModificationsUrlTemplate: source.productModificationsUrlTemplate,
      productIds,
    };
  });
  return {
    schemaVersion: 2,
    vendor: 'idt',
    retrievedAt: value.retrievedAt,
    sourceUrl: value.sourceUrl,
    availabilitySources,
    officialSlashCodeCount: value.officialSlashCodeCount,
    entries: value.entries.map(parseEntry),
  };
}

export const IDT_CATALOG_SNAPSHOT = parseSnapshot(rawSnapshot);
