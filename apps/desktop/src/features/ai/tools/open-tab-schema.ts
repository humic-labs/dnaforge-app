import { z } from 'zod';

export const openTabSchema = z
  .object({
    type: z
      .enum([
        'sequence',
        'page',
        'design',
        'file',
        'structure',
        'protein',
        'pdf',
        'scientific-document',
      ])
      .describe('Type of content to open'),
    entityId: z
      .string()
      .describe(
        'ID or path of the content to open. For type "sequence", this is the stable ' +
        'package/catalog document ID and never a physical file path. For type "protein", this is the ' +
        'protein LIMS entity id, not a file path. For type "pdf", this is the ' +
          'local PDF file path. For type "scientific-document", ' +
          'this is the native protocol or other scientific-document file path.'
      ),
    label: z.string().max(200).optional().describe('Optional display label; the document owner supplies its current name when omitted.'),
    split: z
      .boolean()
      .optional()
      .describe(
        'Deprecated and ignored — content now always opens in the panel next to ' +
          'the chat automatically. Do not manage panes yourself.'
      ),
  })
  .strict();

export type OpenTabInput = z.infer<typeof openTabSchema>;
