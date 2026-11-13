
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { sequenceReadFailure } from './sequence-tool-failure';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import { matchFeatures } from './feature-matching';
import { sequenceResourceUri } from './get-sequence';

const PAGE_SIZE = 50;

export function findFeaturesSchemaForFolders(_folders: WorkspaceFolder[]) {
  return z
    .object({
      documentId: z
        .string()
        .describe(
          'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
        ),
      query: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Matched against every identifier the feature carries: locus tag (e.g. "b0455"), ' +
            'gene symbol, gene synonyms, cross-references ("GeneID:944909"), product, label, ' +
            'and notes. Exact matches rank first, then case-insensitive substring.'
        ),
      type: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Exact match on feature type (e.g., "CDS", "rep_origin", "promoter"). Case-insensitive.'
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          `Skip this many matches before returning. Use with the \`nextOffset\` in the ` +
            `previous response to page through every match; ${PAGE_SIZE} come back at a time. ` +
            'Omit for the first page.'
        ),
    })
    .strict();
}

export const findFeaturesSchema = findFeaturesSchemaForFolders([]);

export function createFindFeaturesTool(folders: WorkspaceFolder[]) {
  const inputSchema = findFeaturesSchemaForFolders(folders);

  return resultTool({
    description:
      'Search annotations/features in a biology file by name or type. ' +
      'Returns exact 1-indexed coordinates (GenBank convention). ' +
      'Use this before create_reference to get accurate coordinates, or to answer ' +
      '"what features does this plasmid have?" ' +
      'Matches any identifier the feature carries — locus tag, gene symbol, synonym, ' +
      'cross-reference, product, or note. ' +
      `Results are paged: \`matchCount\` is the true total, ${PAGE_SIZE} features come back ` +
      'per call, and a `nextOffset` in the response means more remain — pass it as `offset` ' +
      'to continue. No match is unreachable; only one page is in front of you at a time. ' +
      'Physical sequence file paths are not accepted.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      documentId: inputDocumentId,
      query,
      type,
      offset,
    }: z.infer<typeof inputSchema>) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(inputDocumentId, folders);
        const result = loaded.biology;

        if (result.format === 'fasta') {
          return toolSuccess({
            documentId: loaded.documentId,
            coordinateSystem: 'one_based_inclusive',
            resourceUri: sequenceResourceUri(loaded.documentId),
            matchCount: 0,
            features: [],
          });
        }

        const matches = matchFeatures(result.features, query, type);
        const start = offset ?? 0;
        const page = matches.slice(start, start + PAGE_SIZE);
        const nextOffset = start + page.length;
        const hasMore = nextOffset < matches.length;

        return toolSuccess({
          documentId: loaded.documentId,
          coordinateSystem: 'one_based_inclusive',
          resourceUri: sequenceResourceUri(loaded.documentId),
          matchCount: matches.length,
          returnedRange: { offset: start, count: page.length },
          ...(hasMore ? { nextOffset } : {}),
          features: page.map((f) => ({
            name: f.displayName,
            type: f.type,
            start: f.start,
            end: f.end,
            direction: f.direction,
            ...(f.segments && f.segments.length > 1 ? { segments: f.segments } : {}),
            ...(f.exons && f.exons.length > 1 ? { exons: f.exons } : {}),
            ...(f.cds && f.cds.length > 1 ? { cds: f.cds } : {}),
            ...(f.transcriptId ? { transcriptId: f.transcriptId } : {}),
          })),
        });
      } catch (error) {
        return {
          documentId: inputDocumentId,
          ...sequenceReadFailure(
            'FEATURE_READ_FAILED',
            `Failed to find features: ${error instanceof Error ? error.message : 'Unknown error'}`
          ),
        };
      }
    },
  });
}
