import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import { TABLE_NOTEBOOK_BLOCK } from './table-notebook-contract';
import { normalizeLegacyTableData } from './notebook-model/table/normalize-table-data';
import type { TableData } from './table-document-types';

const identity = z.string().min(1).max(1000);
export const tableDocumentReferenceSchema = z
  .object({
    version: z.literal(1),
    documentId: identity,
    backing: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('notebook-inline'),
            notebookDocumentId: identity,
            blockId: identity,
          })
          .strict(),
        z
          .object({
            kind: z.literal('rich-file'),
            projectId: z.string().uuid(),
            tableId: z.string().uuid(),
            fileDocumentId: identity.optional(),
            pathHint: z.string().min(1).max(4096).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('delimited-file'),
            fileDocumentId: identity,
            format: z.enum(['csv', 'tsv']),
          })
          .strict(),
      ])
      .readonly(),
    binding: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('current') }).strict(),
        z
          .object({
            kind: z.literal('saved-version'),
            savedVersionId: identity,
            sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      ])
      .readonly(),
  })
  .strict()
  .readonly();

export type TableDocumentReference = z.infer<typeof tableDocumentReferenceSchema>;

export function notebookTableReference(
  notebookDocumentId: string,
  blockId: string
): TableDocumentReference {
  identity.parse(notebookDocumentId);
  identity.parse(blockId);
  return tableDocumentReferenceSchema.parse({
    version: 1,
    documentId: `notebook-table:${encodeURIComponent(notebookDocumentId)}:${encodeURIComponent(blockId)}`,
    backing: { kind: 'notebook-inline', notebookDocumentId, blockId },
    binding: { kind: 'current' },
  });
}

export function richTableReference(
  projectId: string,
  tableId: string,
  binding: TableDocumentReference['binding'] = { kind: 'current' },
  hints?: { fileDocumentId?: string; pathHint?: string }
): TableDocumentReference {
  const reference = tableDocumentReferenceSchema.parse({
    version: 1,
    documentId: tableId,
    backing: { ...hints, kind: 'rich-file', projectId, tableId },
    binding,
  });
  tableDocumentKey(reference);
  return reference;
}

export function tableDocumentKey(reference: TableDocumentReference): string {
  const value = tableDocumentReferenceSchema.parse(reference);
  if (
    value.backing.kind === 'notebook-inline' &&
    value.documentId !==
      notebookTableReference(value.backing.notebookDocumentId, value.backing.blockId).documentId
  )
    throw new Error('The table reference does not match its notebook and block identity.');
  if (value.backing.kind === 'rich-file') {
    if (value.documentId !== value.backing.tableId)
      throw new Error('The table reference does not match its portable table identity.');
    if (
      value.binding.kind === 'saved-version' &&
      (!/^[a-f0-9]{64}$/.test(value.binding.savedVersionId) ||
        value.binding.sha256 !== `sha256:${value.binding.savedVersionId}`)
    )
      throw new Error('The saved table reference does not match its immutable snapshot digest.');
    const current = `rich-table:${value.backing.projectId}:${value.backing.tableId}`;
    return value.binding.kind === 'current'
      ? current
      : `${current}:saved-version:${value.binding.savedVersionId}`;
  }
  return value.binding.kind === 'current'
    ? value.documentId
    : `${value.documentId}:saved-version:${encodeURIComponent(value.binding.savedVersionId)}`;
}

export function tableDocumentReferenceFromKey(key: string): TableDocumentReference | null {
  const rich = /^rich-table:([^:]+):([^:]+)(?::saved-version:([a-f0-9]{64}))?$/.exec(key);
  if (rich) {
    try {
      const reference = richTableReference(
        rich[1],
        rich[2],
        rich[3]
          ? { kind: 'saved-version', savedVersionId: rich[3], sha256: `sha256:${rich[3]}` }
          : { kind: 'current' }
      );
      return tableDocumentKey(reference) === key ? reference : null;
    } catch {
      return null;
    }
  }
  const match = /^notebook-table:([^:]+):([^:]+)$/.exec(key);
  if (!match) return null;
  try {
    const reference = notebookTableReference(
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2])
    );
    return tableDocumentKey(reference) === key ? reference : null;
  } catch {
    return null;
  }
}

export function notebookTableData(content: JSONContent, blockId: string): TableData {
  const matches: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === 'embed' && node.attrs?.type === 'table' && node.attrs.refId === blockId)
      matches.push(node);
    for (const child of node.content ?? []) visit(child);
  };
  visit(content);
  if (matches.length !== 1)
    throw new Error('This notebook has no unique table with that identity.');
  const node = matches[0];
  if ((node.attrs?.version ?? 1) !== TABLE_NOTEBOOK_BLOCK.currentVersion)
    throw new Error(
      'This table uses an unsupported saved version. Its original data is preserved.'
    );
  const parsed = TABLE_NOTEBOOK_BLOCK.parseData(node.attrs?.data ?? {});
  if (!parsed.ok) throw new Error(parsed.reason);
  return normalizeLegacyTableData(parsed.data);
}
