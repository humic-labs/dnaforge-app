import type { JSONContent } from '@tiptap/core';
import { z } from 'zod';
import { encodeInlineReferenceDeclaration } from '../ai/public/inline-reference-codec';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { normalizeNotebookReferences } from '../../shared/notebook-reference-normalization';
import { createTableBlock } from '../../shared/notebook-model/table/configuration';
import { tableCellContentText } from '../../shared/table-cell-content';

export const notebookInlineSchema = z
  .object({
    text: z.string(),
    referenceId: z.string().uuid().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
  })
  .strict();

const inlineContent = z.array(notebookInlineSchema).max(200);

export const notebookBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), content: inlineContent }).strict(),
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      content: inlineContent,
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      header: z.boolean().default(true),
      rows: z.array(z.array(inlineContent).min(1).max(40)).min(1).max(500),
    })
    .strict(),
]);

export const notebookBlocksSchema = z.array(notebookBlockSchema).min(1).max(1000);

function inlineNodes(content: z.infer<typeof inlineContent>): JSONContent[] {
  return content
    .filter((item) => item.text.length > 0)
    .map((item) => ({
      type: 'text',
      text: item.text,
      marks: [
        ...(item.referenceId
          ? [
              {
                type: 'link',
                attrs: {
                  href: encodeInlineReferenceDeclaration({
                    kind: 'existing-reference',
                    referenceId: item.referenceId,
                  }),
                },
              },
            ]
          : []),
        ...(item.bold ? [{ type: 'bold' }] : []),
        ...(item.italic ? [{ type: 'italic' }] : []),
      ],
    }));
}

export function compileNotebookBlocks(
  input: z.infer<typeof notebookBlocksSchema>,
  options: { tableIdentity?: string; existingDocumentTables?: boolean } = {}
): JSONContent {
  const blocks = notebookBlocksSchema.parse(input);
  const tableIdentity = options.tableIdentity ?? contentFingerprint(JSON.stringify(blocks));
  return {
    type: 'doc',
    content: blocks.map((block, blockIndex): JSONContent => {
      if (block.type === 'table') {
        const columns = block.rows[0].length;
        if (block.rows.some((row) => row.length !== columns))
          throw new Error('Every row of a notebook table must have the same number of columns.');
        if (!options.existingDocumentTables) {
          const cells = block.rows.map((row, rowIndex) =>
            row.map((cell) => {
              const content = inlineNodes(cell).flatMap(
                (node) =>
                  normalizeNotebookReferences({ type: 'paragraph', content: [node] }).content ?? []
              );
              return {
                value: tableCellContentText(content),
                type: 'text' as const,
                ...(content.some((node) => node.type !== 'text' || node.marks?.length)
                  ? { content }
                  : {}),
                ...(block.header && rowIndex === 0 ? { format: { bold: true } } : {}),
              };
            })
          );
          return createTableBlock(`table-${contentFingerprint(`${tableIdentity}:${blockIndex}`)}`, {
            rows: cells.length,
            cols: columns,
            cells,
          });
        }
        return {
          type: 'table',
          content: block.rows.map((row, index) => ({
            type: 'tableRow',
            content: row.map((cell) => ({
              type: block.header && index === 0 ? 'tableHeader' : 'tableCell',
              content: [{ type: 'paragraph', content: inlineNodes(cell) }],
            })),
          })),
        };
      }
      return {
        type: block.type,
        ...(block.type === 'heading' ? { attrs: { level: block.level } } : {}),
        content: inlineNodes(block.content),
      };
    }),
  };
}

export function notebookBlockReferenceIds(input: z.infer<typeof notebookBlocksSchema>): string[] {
  return [
    ...new Set(
      input
        .flatMap((block) => (block.type === 'table' ? block.rows.flat(2) : block.content))
        .flatMap((inline) => (inline.referenceId ? [inline.referenceId] : []))
    ),
  ];
}
