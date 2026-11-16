import { parseDelimitedRows } from '@waypoint/scientific-objects/delimited-rows';
import { inventoryWellId } from './inventory-layout';
import { inventoryReceiveSourceKey } from './inventory-receive-source';
import { inventoryTableSha256 } from './inventory-table-binding';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableFields,
  type InventoryTableIssue,
} from './inventory-table-types';
import type {
  InventoryMappedSourceRow,
  InventoryMappedTableChoices,
  InventoryMappedTableNormalization,
} from './inventory-mapped-table-types';

const key = inventoryReceiveSourceKey;
const digest = /^sha256:[a-f0-9]{64}$/u;
const issue = (code: string, pointer: string, message: string): InventoryTableIssue => ({
  code,
  pointer,
  message,
});
const reason = (value: unknown): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  value.length <= 2000 &&
  !value.includes('\0');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((name) => Object.hasOwn(value, name));
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function optionsShape(value: InventoryMappedTableChoices): boolean {
  if (
    !exact(value, [
      'namespace',
      'delimiter',
      'columns',
      'materials',
      'plates',
      'quantity',
      'qualities',
      'evidenceOnlyColumns',
      'skips',
    ]) ||
    typeof value.namespace !== 'string' ||
    !exact(value.columns, ['sourceId', 'plate', 'well']) ||
    !Object.values(value.columns).every((cell) => typeof cell === 'string') ||
    !exact(value.quantity, ['kind', 'reason']) ||
    typeof value.quantity.reason !== 'string'
  )
    return false;
  for (const field of ['materials', 'plates', 'qualities', 'evidenceOnlyColumns', 'skips'] as const)
    if (!Array.isArray(value[field])) return false;
  return (
    value.materials.every(
      (row) =>
        (exact(row, ['sourceId', 'materialId']) ||
          exact(row, ['sourceId', 'materialId', 'fingerprint'])) &&
        typeof row.sourceId === 'string' &&
        typeof row.materialId === 'string'
    ) &&
    value.plates.every(
      (row) =>
        exact(row, ['sourcePlate', 'storageId', 'positions']) &&
        typeof row.sourcePlate === 'string' &&
        typeof row.storageId === 'string' &&
        Array.isArray(row.positions) &&
        row.positions.every(
          (position) =>
            exact(position, ['sourceWell', 'position']) &&
            typeof position.sourceWell === 'string' &&
            typeof position.position === 'string'
        )
    ) &&
    value.qualities.every(
      (row) =>
        exact(row, ['sourceId', 'quality', 'reason']) &&
        typeof row.sourceId === 'string' &&
        typeof row.quality === 'string' &&
        typeof row.reason === 'string'
    ) &&
    value.evidenceOnlyColumns.every(
      (row) =>
        exact(row, ['column', 'reason']) &&
        typeof row.column === 'string' &&
        typeof row.reason === 'string'
    ) &&
    value.skips.every(
      (row) =>
        exact(row, ['sourceId', 'reason']) &&
        typeof row.sourceId === 'string' &&
        typeof row.reason === 'string'
    )
  );
}

export function normalizeInventoryMappedTable(
  sourceText: string,
  options: InventoryMappedTableChoices,
  maxBytes: number
): InventoryMappedTableNormalization {
  const sourceSha256 = inventoryTableSha256(typeof sourceText === 'string' ? sourceText : '');
  const headers: string[] = [];
  const rows: InventoryMappedSourceRow[] = [];
  const sourceIds = new Set<string>();
  const sourcePlates = new Map<string, Set<string>>();
  const issues: InventoryTableIssue[] = [];
  const facts = () => ({
    sourceSha256,
    headers,
    sourceIds: [...sourceIds].sort(order),
    sourcePlates: [...sourcePlates]
      .sort(([a], [b]) => order(a, b))
      .map(([sourcePlate, wells]) => ({
        sourcePlate,
        sourceWells: [...wells].sort(order),
      })),
    rows,
  });
  const blocked = (): InventoryMappedTableNormalization => ({
    ...facts(),
    kind: 'blocked',
    issues,
    normalizedSourceText: null,
    tableOptions: null,
  });
  if (
    typeof sourceText !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    new TextEncoder().encode(sourceText).byteLength > maxBytes
  ) {
    issues.push(
      issue(
        'MAPPED_SOURCE_TOO_LARGE',
        '/sourceText',
        'The exact spreadsheet must fit the inline native transport byte limit.'
      )
    );
    return blocked();
  }
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(sourceText)
    ) !== sourceText
  ) {
    issues.push(
      issue(
        'MAPPED_SOURCE_UTF8_INVALID',
        '/sourceText',
        'The exact spreadsheet requires valid UTF-8 text.'
      )
    );
    return blocked();
  }
  if (!options || (options.delimiter !== ',' && options.delimiter !== '\t')) {
    issues.push(
      issue('MAPPED_DELIMITER_INVALID', '/options/delimiter', 'Select comma or tab explicitly.')
    );
    return blocked();
  }
  const parsed = parseDelimitedRows(
    sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText,
    options.delimiter
  );
  if (!parsed.ok) {
    issues.push(issue('MAPPED_PARSE_INVALID', '/sourceText', parsed.error));
    return blocked();
  }
  const [sourceHeaders, ...records] = parsed.rows;
  if (sourceHeaders) headers.push(...sourceHeaders);
  if (
    !headers.length ||
    headers.some((header) => !key(header)) ||
    new Set(headers).size !== headers.length
  )
    issues.push(
      issue(
        'MAPPED_HEADERS_INVALID',
        '/sourceText',
        'Source column names must be distinct exact nonblank text of at most 256 characters.'
      )
    );
  const shaped = optionsShape(options);
  if (!shaped)
    issues.push(
      issue(
        'MAPPED_OPTIONS_INVALID',
        '/options',
        'Supply exactly the declared column, material, plate, quantity, quality, evidence and skip choices.'
      )
    );
  const columns = shaped ? options.columns : null;
  const selectedColumns = columns ? Object.values(columns) : [];
  const materialChoices = new Map(
    shaped ? options.materials.map((row) => [row.sourceId, row]) : []
  );
  const plateChoices = new Map(shaped ? options.plates.map((row) => [row.sourcePlate, row]) : []);
  const qualities = new Map(shaped ? options.qualities.map((row) => [row.sourceId, row]) : []);
  const skips = new Map(shaped ? options.skips.map((row) => [row.sourceId, row.reason]) : []);
  if (shaped) {
    if (!key(options.namespace))
      issues.push(
        issue(
          'MAPPED_NAMESPACE_INVALID',
          '/options/namespace',
          'Supply an exact nonblank stable source namespace.'
        )
      );
    if (
      selectedColumns.some((column) => !key(column) || !headers.includes(column)) ||
      new Set(selectedColumns).size !== 3
    )
      issues.push(
        issue(
          'MAPPED_COLUMNS_UNRESOLVED',
          '/options/columns',
          'Choose three distinct source columns for identity, plate and well.'
        )
      );
    if (options.quantity.kind !== 'unknown' || !reason(options.quantity.reason))
      issues.push(
        issue(
          'MAPPED_QUANTITY_UNRESOLVED',
          '/options/quantity',
          'Declare unknown quantity with an explicit reason; this adapter does not infer volume measurements.'
        )
      );
    const seenColumns = new Set(selectedColumns);
    for (const [index, evidence] of options.evidenceOnlyColumns.entries()) {
      if (
        !key(evidence.column) ||
        !headers.includes(evidence.column) ||
        seenColumns.has(evidence.column) ||
        !reason(evidence.reason)
      )
        issues.push(
          issue(
            'MAPPED_COLUMN_DISPOSITION_INVALID',
            `/options/evidenceOnlyColumns/${index}`,
            'Each evidence-only column needs one distinct source column and an explicit reason.'
          )
        );
      seenColumns.add(evidence.column);
    }
    for (const header of headers)
      if (!seenColumns.has(header))
        issues.push(
          issue(
            'MAPPED_COLUMN_UNRESOLVED',
            '/options/evidenceOnlyColumns',
            `Declare how ${JSON.stringify(header)} is retained as evidence; no source column is silently dropped.`
          )
        );
    for (const [name, choices, getKey] of [
      [
        'materials',
        options.materials,
        (row: InventoryMappedTableChoices['materials'][number]) => row.sourceId,
      ],
      [
        'qualities',
        options.qualities,
        (row: InventoryMappedTableChoices['qualities'][number]) => row.sourceId,
      ],
      ['skips', options.skips, (row: InventoryMappedTableChoices['skips'][number]) => row.sourceId],
      [
        'plates',
        options.plates,
        (row: InventoryMappedTableChoices['plates'][number]) => row.sourcePlate,
      ],
    ] as const) {
      const seen = new Set<string>();
      for (const [index, choice] of choices.entries()) {
        const id = getKey(choice as never);
        if (!key(id) || seen.has(id))
          issues.push(
            issue(
              'MAPPED_RESOLUTION_DUPLICATE',
              `/options/${name}/${index}`,
              'Every resolution needs one exact distinct source key.'
            )
          );
        seen.add(id);
      }
    }
    for (const [index, material] of options.materials.entries())
      if (
        !key(material.materialId) ||
        ('fingerprint' in material &&
          (typeof material.fingerprint !== 'string' || !digest.test(material.fingerprint)))
      )
        issues.push(
          issue(
            'MAPPED_MATERIAL_INVALID',
            `/options/materials/${index}`,
            'Select an exact scientific record with a valid resolved fingerprint when supplied.'
          )
        );
    for (const [index, quality] of options.qualities.entries())
      if (
        !skips.has(quality.sourceId) &&
        ((quality.quality !== 'usable' && quality.quality !== 'quarantined') ||
          !reason(quality.reason))
      )
        issues.push(
          issue(
            'MAPPED_QUALITY_INVALID',
            `/options/qualities/${index}`,
            'Choose usable or quarantined with a reason; source QC fields do not choose quality.'
          )
        );
    for (const [index, skip] of options.skips.entries())
      if (!reason(skip.reason))
        issues.push(
          issue(
            'MAPPED_SKIP_INVALID',
            `/options/skips/${index}`,
            'Skipping a source row requires an explicit reason.'
          )
        );
    for (const [index, plate] of options.plates.entries()) {
      const wells = new Set<string>();
      const positions = new Set<string>();
      if (!key(plate.storageId))
        issues.push(
          issue(
            'MAPPED_PLATE_INVALID',
            `/options/plates/${index}`,
            'Choose an existing fixed-well plate explicitly.'
          )
        );
      for (const [positionIndex, position] of plate.positions.entries()) {
        if (
          !key(position.sourceWell) ||
          !key(position.position) ||
          wells.has(position.sourceWell) ||
          positions.has(position.position)
        )
          issues.push(
            issue(
              'MAPPED_POSITION_INVALID',
              `/options/plates/${index}/positions/${positionIndex}`,
              'Each source well needs one distinct explicit destination position; no leading zero translation is automatic.'
            )
          );
        wells.add(position.sourceWell);
        positions.add(position.position);
      }
    }
  }
  const seenIds = new Set<string>();
  const usedDestinations = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    const pointer = `/rows/${index + 2}`;
    const rowIssues: InventoryTableIssue[] = [];
    const sourceFields =
      record.length === headers.length && new Set(headers).size === headers.length
        ? Object.fromEntries(headers.map((header, cell) => [header, record[cell]]))
        : null;
    const sourceId =
      columns && sourceFields && Object.hasOwn(sourceFields, columns.sourceId)
        ? sourceFields[columns.sourceId]
        : null;
    const sourcePlate =
      columns && sourceFields && Object.hasOwn(sourceFields, columns.plate)
        ? sourceFields[columns.plate]
        : null;
    const sourceWell =
      columns && sourceFields && Object.hasOwn(sourceFields, columns.well)
        ? sourceFields[columns.well]
        : null;
    if (!sourceFields)
      rowIssues.push(
        issue(
          'MAPPED_ROW_WIDTH_INVALID',
          pointer,
          'Every source row must contain exactly the declared number of fields.'
        )
      );
    if (!key(sourceId))
      rowIssues.push(
        issue(
          'MAPPED_SOURCE_ID_INVALID',
          `${pointer}/sourceId`,
          'Resolve a stable exact source identity from the selected identity column.'
        )
      );
    else {
      sourceIds.add(sourceId);
      if (seenIds.has(sourceId))
        rowIssues.push(
          issue(
            'MAPPED_SOURCE_ID_DUPLICATE',
            `${pointer}/sourceId`,
            `Source identity ${JSON.stringify(sourceId)} repeats in the source.`
          )
        );
      seenIds.add(sourceId);
    }
    if (key(sourcePlate)) {
      const wells = sourcePlates.get(sourcePlate) ?? new Set<string>();
      if (key(sourceWell)) wells.add(sourceWell);
      sourcePlates.set(sourcePlate, wells);
    }
    const skipped = sourceId !== null && skips.has(sourceId);
    const material = sourceId === null ? undefined : materialChoices.get(sourceId);
    const quality = sourceId === null ? undefined : qualities.get(sourceId);
    const plate = sourcePlate === null ? undefined : plateChoices.get(sourcePlate);
    const position =
      plate?.positions.find((choice) => choice.sourceWell === sourceWell)?.position ?? null;
    const vesselId = plate && position !== null ? inventoryWellId(plate.storageId, position) : null;
    if (!skipped) {
      if (!material)
        rowIssues.push(
          issue(
            'MAPPED_MATERIAL_UNRESOLVED',
            `${pointer}/materialId`,
            'Bind this source identity to an admitted scientific record.'
          )
        );
      if (!quality)
        rowIssues.push(
          issue(
            'MAPPED_QUALITY_UNRESOLVED',
            `${pointer}/quality`,
            'Choose this row’s physical quality explicitly with a reason.'
          )
        );
      if (!key(sourcePlate) || !key(sourceWell) || !plate || position === null)
        rowIssues.push(
          issue(
            'MAPPED_PLATE_UNRESOLVED',
            `${pointer}/plate`,
            'Resolve the exact source plate and well to an existing permanent well.'
          )
        );
      if (vesselId && sourceId !== null) {
        const previous = usedDestinations.get(vesselId);
        if (previous !== undefined && previous !== sourceId)
          rowIssues.push(
            issue(
              'MAPPED_DESTINATION_DUPLICATE',
              `${pointer}/well`,
              'Two source identities resolve to the same physical well; the whole proposal is blocked.'
            )
          );
        usedDestinations.set(vesselId, sourceId);
      }
    }
    const fields: InventoryReceiveTableFields | null = key(sourceId)
      ? {
          source_id: sourceId,
          name: '',
          material_key: skipped ? '' : sourceId,
          quantity_kind: skipped ? '' : 'unknown',
          quantity: '',
          unit: '',
          quality: skipped ? '' : (quality?.quality ?? ''),
          vessel_kind: skipped ? '' : 'existing',
          vessel_key: skipped ? '' : sourceId,
          location_key: '',
          slot: '',
        }
      : null;
    rows.push({
      index: index + 2,
      sourceId,
      sourceFields,
      sourcePlate,
      sourceWell,
      materialId: skipped ? null : (material?.materialId ?? null),
      vesselId: skipped ? null : vesselId,
      position: skipped ? null : position,
      quality: skipped ? null : (quality?.quality ?? null),
      kind: rowIssues.length ? 'blocked' : skipped ? 'skipped' : 'normalized',
      fields,
      issues: rowIssues,
    });
    issues.push(...rowIssues);
  }
  if (shaped) {
    for (const [name, choices] of [
      ['materials', options.materials],
      ['qualities', options.qualities],
      ['skips', options.skips],
    ] as const)
      for (const choice of choices)
        if (!sourceIds.has(choice.sourceId))
          issues.push(
            issue(
              'MAPPED_RESOLUTION_UNUSED',
              `/options/${name}`,
              `Source identity ${JSON.stringify(choice.sourceId)} is not present in this file.`
            )
          );
    for (const plate of options.plates) {
      const wells = sourcePlates.get(plate.sourcePlate);
      if (!wells)
        issues.push(
          issue(
            'MAPPED_RESOLUTION_UNUSED',
            '/options/plates',
            `Source plate ${JSON.stringify(plate.sourcePlate)} is not present in this file.`
          )
        );
      for (const position of plate.positions)
        if (!wells?.has(position.sourceWell))
          issues.push(
            issue(
              'MAPPED_RESOLUTION_UNUSED',
              '/options/plates',
              `Source well ${JSON.stringify(position.sourceWell)} is not present on this source plate.`
            )
          );
    }
  }
  if (issues.length) return blocked();
  const included = rows.filter((row) => row.kind === 'normalized');
  return {
    ...facts(),
    kind: 'normalized',
    issues: [],
    normalizedSourceText:
      [
        INVENTORY_RECEIVE_TABLE_COLUMNS.join(','),
        ...rows.map((row) =>
          INVENTORY_RECEIVE_TABLE_COLUMNS.map((column) => quote(row.fields![column])).join(',')
        ),
      ].join('\n') + '\n',
    tableOptions: {
      namespace: options.namespace,
      delimiter: ',',
      materials: included.map((row) => ({ key: row.sourceId!, materialId: row.materialId! })),
      locations: [],
      vessels: included.map((row) => ({ key: row.sourceId!, vesselId: row.vesselId! })),
      skips: [...options.skips],
    },
  };
}
