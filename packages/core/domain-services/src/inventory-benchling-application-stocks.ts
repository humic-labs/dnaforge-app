import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';
import { inventoryReceiveTableFieldIssues } from './inventory-receive-source';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableFields,
  type InventoryResolvedTableOptions,
  type InventoryTableIssue,
} from './inventory-table-types';
import type { InventoryResolvedBenchlingCaptureOptions } from './inventory-benchling-application-types';
import {
  BenchlingApplicationError,
  fail,
  shape,
  recordKey,
  resolveInventoryBenchlingApplicationSource,
  type ResolvedBenchlingSource,
} from './inventory-benchling-application-source';

export function benchlingChoices(options: InventoryResolvedBenchlingCaptureOptions) {
  return {
    scopeAcceptance: options.scopeAcceptance,
    records: options.records,
    sourceIssueDispositions: options.sourceIssueDispositions,
    uncapturedPositions: options.uncapturedPositions,
  };
}
export function canonicalBenchlingStockTable(rows: readonly InventoryReceiveTableFields[]): string {
  const quote = (value: string) =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return (
    INVENTORY_RECEIVE_TABLE_COLUMNS.join(',') +
    '\n' +
    rows
      .map((row) => INVENTORY_RECEIVE_TABLE_COLUMNS.map((key) => quote(row[key])).join(','))
      .join('\n') +
    (rows.length ? '\n' : '')
  );
}
export function benchlingStockFacts(
  source: ResolvedBenchlingSource,
  materials: InventoryResolvedBenchlingCaptureOptions['materials'],
  targets: InventoryResolvedBenchlingCaptureOptions['resolvedTargets']
) {
  const expected = source.vessels.filter((item) => item.contents.kind === 'identify');
  if (
    !Array.isArray(materials) ||
    materials.length !== expected.length ||
    !Array.isArray(targets) ||
    targets.length !== source.storage.length + source.vessels.length
  )
    fail(
      'BENCHLING_RESOLVED_OPTIONS_INVALID',
      '/options',
      'Resolved scientific identities and physical targets must cover exactly the imported records.'
    );
  const targetMap = new Map<string, string>();
  for (const item of targets) {
    shape(item, ['record', 'target'], '/options/resolvedTargets');
    shape(item.record, ['kind', 'sourceId'], '/options/resolvedTargets');
    shape(item.target, ['kind', 'id'], '/options/resolvedTargets');
    const key = recordKey(item.record);
    if (
      targetMap.has(key) ||
      typeof item.target.id !== 'string' ||
      !item.target.id.trim() ||
      item.target.id.includes('\0') ||
      item.target.id.length > 1024 ||
      (item.record.kind === 'container'
        ? item.target.kind !== 'vessel'
        : item.target.kind !== 'storage') ||
      ![...source.storage, ...source.vessels].some((entry) => recordKey(entry.record) === key)
    )
      fail(
        'BENCHLING_RESOLVED_TARGET_INVALID',
        '/options/resolvedTargets',
        'Every imported source needs one exact target of the matching physical kind.'
      );
    targetMap.set(key, item.target.id);
  }
  const materialMap = new Map<string, (typeof materials)[number]>();
  for (const material of materials) {
    shape(material, ['sourceId', 'materialId', 'fingerprint'], '/options/materials');
    if (
      materialMap.has(material.sourceId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(material.fingerprint) ||
      !expected.some(
        (item) =>
          item.record.sourceId === material.sourceId &&
          item.contents.kind === 'identify' &&
          item.contents.materialId === material.materialId
      )
    )
      fail(
        'BENCHLING_MATERIAL_BINDING_INVALID',
        '/options/materials',
        'Saved material fingerprints must match the explicit single-content scientific choices.'
      );
    materialMap.set(material.sourceId, material);
  }
  const rows: InventoryReceiveTableFields[] = [];
  const normalizedMaterials = new Map<string, InventoryResolvedTableOptions['materials'][number]>();
  const vessels: InventoryResolvedTableOptions['vessels'][number][] = [];
  for (const item of expected) {
    const contents = item.contents;
    if (contents.kind !== 'identify') continue;
    const material = materialMap.get(item.record.sourceId)!;
    const prior = normalizedMaterials.get(contents.materialKey);
    if (
      prior &&
      (prior.materialId !== material.materialId || prior.fingerprint !== material.fingerprint)
    )
      fail(
        'BENCHLING_SCIENTIFIC_IDENTITY_AMBIGUOUS',
        '/options/materials',
        'One foreign scientific identity cannot silently select different local materials.'
      );
    normalizedMaterials.set(contents.materialKey, {
      key: contents.materialKey,
      materialId: material.materialId,
      fingerprint: material.fingerprint,
    });
    const row: InventoryReceiveTableFields = {
      source_id: item.record.sourceId,
      name: '',
      material_key: contents.materialKey,
      quantity_kind: contents.quantity.kind,
      quantity: contents.quantity.kind === 'known' ? contents.quantity.value : '',
      unit: contents.quantity.kind === 'known' ? contents.quantity.unit : '',
      quality: contents.quality,
      vessel_kind: 'existing',
      vessel_key: item.record.sourceId,
      location_key: '',
      slot: '',
    };
    const issues = inventoryReceiveTableFieldIssues(row);
    if (issues.length) throw new BenchlingApplicationError(issues[0]);
    rows.push(row);
    vessels.push({ key: item.record.sourceId, vesselId: targetMap.get(recordKey(item.record))! });
  }
  return {
    rows,
    sourceText: canonicalBenchlingStockTable(rows),
    options: {
      namespace: source.inspection.capture!.namespace,
      delimiter: ',' as const,
      materials: [...normalizedMaterials.values()].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      ),
      vessels,
      locations: [],
      skips: [],
    } satisfies InventoryResolvedTableOptions,
  };
}
export function normalizeInventoryBenchlingCaptureStocks(
  sourceText: string,
  options: InventoryResolvedBenchlingCaptureOptions,
  maxBytes: number
):
  | {
      kind: 'normalized';
      rows: readonly InventoryReceiveTableFields[];
      sourceText: string;
      options: InventoryResolvedTableOptions;
    }
  | { kind: 'blocked'; issues: readonly InventoryTableIssue[] } {
  try {
    shape(
      options,
      [
        'scopeAcceptance',
        'records',
        'sourceIssueDispositions',
        'uncapturedPositions',
        'materials',
        'resolvedTargets',
        'normalizedStockRows',
        'normalizedTableOptions',
      ],
      '/options'
    );
    const source = resolveInventoryBenchlingApplicationSource(
      sourceText,
      benchlingChoices(options),
      maxBytes
    );
    const normalized = benchlingStockFacts(source, options.materials, options.resolvedTargets);
    if (
      canonical(normalized.rows) !== canonical(options.normalizedStockRows) ||
      canonical(normalized.options) !== canonical(options.normalizedTableOptions)
    )
      fail(
        'BENCHLING_STOCK_PREIMAGE_MISMATCH',
        '/options',
        'Saved canonical stock fields/options must regenerate exactly from the retained source and choices.'
      );
    return { kind: 'normalized', ...normalized };
  } catch (error) {
    return {
      kind: 'blocked',
      issues: [
        error instanceof BenchlingApplicationError
          ? error.issue
          : {
              code: 'BENCHLING_RESOLVED_OPTIONS_INVALID',
              pointer: '/options',
              message: error instanceof Error ? error.message : 'Invalid saved source choices.',
            },
      ],
    };
  }
}
