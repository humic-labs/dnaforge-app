import { isUnknownRecord, type NotebookRichBlockContract } from './notebook-content-extension';
import { markdownLabel } from './notebook-reference';
import { tableDocumentKey, tableDocumentReferenceSchema } from './table-document-reference';

function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every((entry) => json(entry, seen));
  seen.delete(value);
  return valid;
}

export const TABLE_REFERENCE_NOTEBOOK_BLOCK = {
  kind: 'rich-block',
  type: 'table-reference',
  currentVersion: 1,
  migrations: [],
  parseData: (value) => {
    if (!isUnknownRecord(value) || !json(value))
      return { ok: false, reason: 'A table placement must contain finite JSON data.' };
    if (['cells', 'rows', 'cols', 'tableData'].some((key) => key in value))
      return {
        ok: false,
        reason: 'A table placement references its data owner and cannot contain copied cells.',
      };
    if (value.presentation !== 'embed' && value.presentation !== 'link')
      return { ok: false, reason: 'Choose an embed or link table presentation.' };
    if (value.label !== undefined && typeof value.label !== 'string')
      return { ok: false, reason: 'A table placement label must be text.' };
    const reference = tableDocumentReferenceSchema.safeParse(value.reference);
    if (!reference.success || reference.data.backing.kind !== 'rich-file')
      return { ok: false, reason: 'The table placement has no valid durable table reference.' };
    try {
      tableDocumentKey(reference.data);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, data: value };
  },
  toMarkdown: ({ data }) => {
    const reference = tableDocumentReferenceSchema.parse(data.reference);
    const key = tableDocumentKey(reference);
    const label = typeof data.label === 'string' && data.label.trim() ? data.label : 'Table';
    return `[${markdownLabel(label)}](<dnaforge-table:${encodeURIComponent(key)}>)`;
  },
} satisfies NotebookRichBlockContract;
