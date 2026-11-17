import { useMemo } from 'react';
import { TABLE_REFERENCE_NOTEBOOK_BLOCK } from '../../../../shared/table-reference-notebook-contract';
import {
  tableDocumentKey,
  tableDocumentReferenceSchema,
  tableDocumentReferenceFromKey,
} from '../../../../shared/table-document-reference';
import { useCanvasStore } from '../../../canvas/public/store';
import type { EmbedRendererProps } from '../types';
import { TablePanel } from './components/TablePanel';
import { TelemetryBlockedSurface } from '../../../../components/TelemetryBlockedSurface';

export function TableReferenceRenderer({ attrs, onRemove }: EmbedRendererProps) {
  const openWithSmartPlacement = useCanvasStore((state) => state.openWithSmartPlacement);
  const parsed = TABLE_REFERENCE_NOTEBOOK_BLOCK.parseData(attrs);
  const referenceKey = parsed.ok
    ? tableDocumentKey(tableDocumentReferenceSchema.parse(parsed.data.reference))
    : null;
  const reference = useMemo(
    () => (referenceKey ? tableDocumentReferenceFromKey(referenceKey) : null),
    [referenceKey]
  );
  if (!parsed.ok || !reference)
    return (
      <div role="alert" className="my-2 rounded border border-border p-3 text-sm">
        {parsed.ok
          ? 'The table reference is unavailable. Its saved data is preserved.'
          : parsed.reason}
      </div>
    );
  const key = tableDocumentKey(reference);
  const presentation = parsed.data.presentation === 'link' ? 'link' : 'embed';
  const title = typeof parsed.data.label === 'string' ? parsed.data.label : 'Table';
  const open = () =>
    openWithSmartPlacement('table', key, title, undefined, { tableDocument: reference });
  return (
    <TelemetryBlockedSurface
      data-table-document={key}
      data-table-presentation={presentation}
      className="my-3 overflow-hidden rounded-lg border border-border bg-bg"
    >
      <div
        className="flex items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2 text-sm"
        contentEditable={false}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {reference.binding.kind === 'saved-version' && (
          <span className="text-xs text-fg-muted">Saved version</span>
        )}
        <button
          type="button"
          onClick={open}
          className="rounded border border-border px-2 py-1 text-xs"
        >
          {presentation === 'link' ? 'Open table' : 'Open in tab'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove table reference"
          className="rounded px-1 text-fg-muted"
        >
          ×
        </button>
      </div>
      {presentation === 'embed' && (
        <div className="h-[420px]" contentEditable={false}>
          <TablePanel tableId={key} tableDocument={reference} embedded />
        </div>
      )}
    </TelemetryBlockedSurface>
  );
}
