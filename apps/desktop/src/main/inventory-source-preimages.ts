import {
  inventoryReceiveTableRowSha256,
  normalizeInventoryMappedTable,
  parseInventoryArchive,
  parseInventoryReceiveTableSource,
  type InventoryReceiveTableFields,
  type InventorySourceRevisionPreimage,
  type InventoryState,
} from '@waypoint/domain-services';
import type { NativeInventoryHistoryEntry } from '../shared/inventory-command';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';
import { nativeInventoryArchiveRuntime } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

export function findNativeInventorySourcePreimages(
  state: InventoryState | null,
  entries: readonly NativeInventoryHistoryEntry[],
  namespace: string,
  sourceIds: ReadonlySet<string>
): readonly InventorySourceRevisionPreimage[] {
  if (!state) return [];
  const expected = new Map(
    Object.values(state.tableBindings)
      .filter((binding) => binding.namespace === namespace && sourceIds.has(binding.sourceId))
      .map((binding) => [
        binding.sourceId,
        binding.sourceRevisions.at(-1)?.rowSha256 ?? binding.rowSha256,
      ])
  );
  const found = new Map<string, InventoryReceiveTableFields>();
  const retain = (sourceId: string, fields: InventoryReceiveTableFields) => {
    if (
      fields.source_id === sourceId &&
      expected.get(sourceId) === inventoryReceiveTableRowSha256(fields)
    )
      found.set(sourceId, fields);
  };
  for (const binding of Object.values(state.tableBindings)) {
    if (binding.namespace !== namespace || !sourceIds.has(binding.sourceId)) continue;
    const revision = binding.sourceRevisions.at(-1);
    if (revision) retain(binding.sourceId, revision.fields);
  }
  const table = (sourceText: string, delimiter: ',' | '\t') => {
    const parsed = parseInventoryReceiveTableSource(
      sourceText,
      delimiter,
      NATIVE_DOCUMENT_MAX_BODY_BYTES
    );
    if (parsed.issues.length) return;
    for (const row of parsed.rows)
      if (row.sourceId !== null && row.fields !== null && row.issues.length === 0)
        retain(row.sourceId, row.fields);
  };
  const visit = (history: readonly NativeInventoryHistoryEntry[], depth: number) => {
    for (const entry of history) {
      if (found.size === expected.size) return;
      const request = entry.request;
      if (!('kind' in request)) continue;
      if (request.kind === 'receive-table' && request.options.namespace === namespace)
        table(request.sourceText, request.options.delimiter);
      if (request.kind === 'receive-mapped-table' && request.options.namespace === namespace) {
        const normalized = normalizeInventoryMappedTable(
          request.sourceText,
          request.options,
          NATIVE_DOCUMENT_MAX_BODY_BYTES
        );
        if (normalized.kind === 'normalized') table(normalized.normalizedSourceText, ',');
      }
      if (
        request.kind === 'acknowledge-table-source' &&
        request.options.table.namespace === namespace
      ) {
        table(request.sourceText, request.options.table.delimiter);
        for (const preimage of request.options.preimages)
          retain(preimage.sourceId, preimage.fields);
      }
      if (request.kind === 'adopt-archive') {
        const archive = parseInventoryArchive(request.sourceText, nativeInventoryArchiveRuntime, {
          depth,
        });
        const source = archive.document.content.source;
        visit(
          archive.document.content.history.map((row) =>
            parseNativeInventoryJournalEntry(
              {
                inventory_id: source.inventoryId,
                operation_id: row.operationId,
                revision: row.revision,
              },
              source.projectId,
              { request: JSON.parse(row.requestJson), receipt: JSON.parse(row.receiptJson) }
            )
          ),
          depth + 1
        );
      }
    }
  };
  if (found.size < expected.size) visit(entries, 0);
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sourceId, fields]) => ({ sourceId, fields }));
}
