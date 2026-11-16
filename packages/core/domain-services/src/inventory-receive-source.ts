import { parseDelimitedRows } from '@waypoint/scientific-objects/delimited-rows';
import { INVENTORY_DECIMAL_PATTERN, INVENTORY_VOLUME_UNITS } from './inventory-types';
import { normalizeInventoryVolume } from './inventory-volume';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from './inventory-table-binding';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  type InventoryReceiveTableFields,
  type InventoryTableIssue,
  type InventoryTableSha256,
} from './inventory-table-types';

export interface InventoryReceiveTableSourceRow {
  readonly index: number;
  readonly sourceId: string | null;
  readonly fields: InventoryReceiveTableFields | null;
  readonly issues: readonly InventoryTableIssue[];
}

export interface InventoryReceiveTableSource {
  readonly sourceSha256: InventoryTableSha256;
  readonly rows: readonly InventoryReceiveTableSourceRow[];
  readonly issues: readonly InventoryTableIssue[];
}

export const inventoryReceiveSourceKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 256 &&
  Boolean(value.trim()) &&
  !value.includes('\0');

export function inventoryReceiveTableRowSha256(
  fields: InventoryReceiveTableFields
): InventoryTableSha256 {
  return inventoryTableSha256(
    inventoryTableCanonicalJson({ format: 'dnaforge.inventory-receive-row.v1', fields })
  );
}

export function parseInventoryReceiveTableSource(
  sourceText: string,
  delimiter: ',' | '\t',
  maxBytes: number
): InventoryReceiveTableSource {
  const sourceSha256 = inventoryTableSha256(typeof sourceText === 'string' ? sourceText : '');
  const rows: InventoryReceiveTableSourceRow[] = [];
  const issues: InventoryTableIssue[] = [];
  const issue = (code: string, pointer: string, message: string) => ({ code, pointer, message });
  const result = () => ({ sourceSha256, rows, issues });
  if (
    typeof sourceText !== 'string' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    new TextEncoder().encode(sourceText).byteLength > maxBytes
  ) {
    issues.push(
      issue(
        'TABLE_SOURCE_TOO_LARGE',
        '/sourceText',
        'The exact table must fit the inline native transport byte limit.'
      )
    );
    return result();
  }
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(sourceText)
    ) !== sourceText
  ) {
    issues.push(
      issue(
        'TABLE_SOURCE_UTF8_INVALID',
        '/sourceText',
        'The exact table requires valid UTF-8 text.'
      )
    );
    return result();
  }
  if (delimiter !== ',' && delimiter !== '\t') {
    issues.push(
      issue('TABLE_DELIMITER_INVALID', '/options/delimiter', 'Select comma or tab explicitly.')
    );
    return result();
  }
  const parsed = parseDelimitedRows(
    sourceText.startsWith('\uFEFF') ? sourceText.slice(1) : sourceText,
    delimiter
  );
  if (!parsed.ok) {
    issues.push(issue('TABLE_PARSE_INVALID', '/sourceText', parsed.error));
    return result();
  }
  const [headers, ...records] = parsed.rows;
  if (
    !headers ||
    headers.length !== INVENTORY_RECEIVE_TABLE_COLUMNS.length ||
    new Set(headers).size !== headers.length ||
    INVENTORY_RECEIVE_TABLE_COLUMNS.some((key) => !headers.includes(key))
  ) {
    issues.push(
      issue(
        'TABLE_HEADERS_INVALID',
        '/sourceText',
        `Use every canonical column exactly once and no other columns: ${INVENTORY_RECEIVE_TABLE_COLUMNS.join(', ')}.`
      )
    );
    return result();
  }
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    const pointer = `/rows/${index + 2}`;
    const rowIssues: InventoryTableIssue[] = [];
    const fields =
      record.length === headers.length
        ? (Object.fromEntries(
            headers.map((key, cell) => [key, record[cell]])
          ) as unknown as InventoryReceiveTableFields)
        : null;
    const sourceId = fields?.source_id ?? null;
    if (!fields)
      rowIssues.push(
        issue(
          'TABLE_ROW_WIDTH_INVALID',
          pointer,
          'Every row must contain exactly the declared number of fields.'
        )
      );
    if (!inventoryReceiveSourceKey(sourceId))
      rowIssues.push(
        issue(
          'TABLE_SOURCE_ID_INVALID',
          `${pointer}/source_id`,
          'Every row needs an exact stable source identity.'
        )
      );
    else if (ids.has(sourceId))
      rowIssues.push(
        issue(
          'TABLE_SOURCE_ID_DUPLICATE',
          `${pointer}/source_id`,
          `Source identity ${JSON.stringify(sourceId)} repeats in this file.`
        )
      );
    else ids.add(sourceId);
    rows.push({ index: index + 2, sourceId, fields, issues: rowIssues });
  }
  return result();
}

export function inventoryReceiveTableFieldIssues(
  value: unknown,
  pointer = '/fields'
): readonly InventoryTableIssue[] {
  const issues: InventoryTableIssue[] = [];
  const add = (code: string, field: string, message: string) =>
    issues.push({ code, pointer: `${pointer}/${field}`, message });
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== INVENTORY_RECEIVE_TABLE_COLUMNS.length ||
    INVENTORY_RECEIVE_TABLE_COLUMNS.some(
      (key) =>
        !Object.hasOwn(value, key) || typeof (value as Record<string, unknown>)[key] !== 'string'
    )
  )
    return [
      {
        code: 'TABLE_FIELDS_INVALID',
        pointer,
        message: 'Receive fields require every canonical string field exactly once.',
      },
    ];
  const fields = value as InventoryReceiveTableFields;
  if (!inventoryReceiveSourceKey(fields.source_id))
    add('TABLE_SOURCE_ID_INVALID', 'source_id', 'Every row needs an exact stable source identity.');
  if (!inventoryReceiveSourceKey(fields.material_key))
    add('TABLE_MATERIAL_KEY_INVALID', 'material_key', 'Supply an exact scientific material key.');
  if (fields.quantity_kind === 'known') {
    if (
      fields.quantity.length > 128 ||
      !new RegExp(INVENTORY_DECIMAL_PATTERN, 'u').test(fields.quantity) ||
      !INVENTORY_VOLUME_UNITS.includes(fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number])
    )
      add(
        'TABLE_QUANTITY_INVALID',
        'quantity',
        'Declare an exact nonnegative decimal and supported volume unit.'
      );
    else {
      try {
        normalizeInventoryVolume({
          value: fields.quantity,
          unit: fields.unit as (typeof INVENTORY_VOLUME_UNITS)[number],
        });
      } catch {
        add(
          'TABLE_QUANTITY_INVALID',
          'quantity',
          'The exact quantity exceeds supported volume bounds.'
        );
      }
    }
  } else if (fields.quantity_kind !== 'unknown' || fields.quantity !== '' || fields.unit !== '')
    add('TABLE_QUANTITY_INVALID', 'quantity', 'Unknown volume requires blank quantity and unit.');
  if (fields.quality !== 'usable' && fields.quality !== 'quarantined')
    add('TABLE_QUALITY_INVALID', 'quality', 'Declare usable or quarantined explicitly.');
  if (fields.vessel_kind === 'new') {
    if (
      !fields.name.trim() ||
      fields.name.length > 512 ||
      fields.name.includes('\0') ||
      fields.vessel_key !== '' ||
      !inventoryReceiveSourceKey(fields.location_key)
    )
      add(
        'TABLE_NEW_VESSEL_INVALID',
        'vessel_kind',
        'A new vessel requires a name, blank vessel_key and an explicit location_key.'
      );
    if (fields.slot.length > 512 || fields.slot.includes('\0'))
      add('TABLE_LOCATION_UNRESOLVED', 'slot', 'Use an exact supported slot identifier.');
  } else if (fields.vessel_kind === 'existing') {
    if (
      !inventoryReceiveSourceKey(fields.vessel_key) ||
      fields.name !== '' ||
      fields.location_key !== '' ||
      fields.slot !== ''
    )
      add(
        'TABLE_EXISTING_VESSEL_INVALID',
        'vessel_kind',
        'An existing vessel requires a vessel_key and blank name, location_key and slot.'
      );
  } else add('TABLE_VESSEL_KIND_INVALID', 'vessel_kind', 'Select new or existing explicitly.');
  return issues;
}
