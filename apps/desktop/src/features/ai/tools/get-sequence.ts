
import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { sequenceReadFailure } from './sequence-tool-failure';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { ParsedBiologyFile } from './parse-biology-file';
import { loadSequenceDocumentBiologyFile, normalizeSequenceDocumentId } from './path-utils';


const MAX_INLINE_SEQUENCE_BP = 10_000;
const MAX_RESOURCE_FEATURES = 100;

export function getSequenceSchemaForFolders(_folders: WorkspaceFolder[]) {
  return z
    .object({
      documentId: z
        .string()
        .min(1)
        .describe(
          'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
        ),
      start: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Optional 1-indexed inclusive start of a sequence window (GenBank convention). ' +
            'Use with `end` to read any region of a genome too large to inline whole. ' +
            'Omit both to get the record without a window.'
        ),
      end: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional 1-indexed inclusive end of the sequence window. Requires `start`.'),
      wraps: z
        .boolean()
        .optional()
        .describe(
          'Set true when the window crosses the origin of a CIRCULAR record ' +
            '(start > end), e.g. 4600000..1000. Matches `highlight_range` and ' +
            '`get_selection_bases`. Without it, start > end is rejected rather than guessed at.'
        ),
    })
    .strict();
}

export const getSequenceSchema = getSequenceSchemaForFolders([]);

export function createGetSequenceTool(folders: WorkspaceFolder[]) {
  const inputSchema = getSequenceSchemaForFolders(folders);

  return resultTool({
    description:
      'Read canonical DNAForge sequence state by stable document ID or waypoint://sequence URI. ' +
      'Use this to inspect the visible sequence resource an agent is working from. ' +
      'A record longer than can be inlined returns `sequence: null` with a preview — pass ' +
      '`start`/`end` (1-indexed, inclusive) to read any window of it, so no region of a ' +
      'genome is out of reach.',
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      documentId: inputDocumentId,
      start,
      end,
      wraps,
    }: z.infer<typeof inputSchema>) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(inputDocumentId, folders);
        const result = buildGetSequenceResult(loaded.biology, loaded.documentId, {
          start,
          end,
          wraps,
        });
        if (typeof result.error === 'string')
          return { ...result, ...sequenceReadFailure('INVALID_SEQUENCE_WINDOW', result.error) };
        return toolSuccess(result);
      } catch (error) {
        const documentId = (() => {
          try {
            return normalizeSequenceDocumentId(inputDocumentId);
          } catch {
            return inputDocumentId;
          }
        })();
        return toolSuccess({
          exists: false,
          documentId,
          resourceUri: sequenceResourceUri(documentId),
          error: `Sequence not found or unreadable: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        });
      }
    },
  });
}

function resolveSequenceWindow(
  window: { start?: number; end?: number; wraps?: boolean } | undefined,
  length: number,
  circular: boolean
): { start: number; end: number; wraps: boolean } | { error: string } | null {
  if (!window || window.start === undefined) return null;
  if (length <= 0) return null;

  const start = Math.min(Math.max(1, window.start), length);
  const rawEnd = window.end ?? length;
  const end = Math.min(Math.max(1, rawEnd), length);

  if (window.wraps && !circular) {
    return {
      error:
        `wraps: true is only valid for a circular record, and this one is linear. ` +
        `A linear sequence has no origin to cross.`,
    };
  }

  if (start > end) {
    if (!window.wraps) {
      return {
        error:
          `Window start (${start}) is after end (${end}). For a region that crosses the ` +
          `origin of a circular record, pass wraps: true. Otherwise correct the coordinates.`,
      };
    }
    return { start, end, wraps: true };
  }

  if (window.wraps) {
    return {
      error:
        `wraps: true means the window crosses the origin, so start must be AFTER end ` +
        `(got ${start}..${end}). Drop wraps for an ordinary window.`,
    };
  }

  return { start, end, wraps: false };
}

function buildGetSequenceResult(
  parsedFile: Omit<ParsedBiologyFile, 'content'>,
  documentId: string,
  window?: { start?: number; end?: number; wraps?: boolean }
) {
  const parsed = parsedFile.sequence;
  const sequence = parsed.sequence ?? '';

  const requested = resolveSequenceWindow(window, sequence.length, parsed.circular === true);
  if (requested && 'error' in requested) {
    return {
      exists: true,
      coordinateSystem: 'one_based_inclusive',
      documentId,
      resourceUri: sequenceResourceUri(documentId),
      error: requested.error,
    };
  }
  if (requested) {
    const slice = requested.wraps
      ? sequence.slice(requested.start - 1) + sequence.slice(0, requested.end)
      : sequence.slice(requested.start - 1, requested.end);
    return {
      exists: true,
      coordinateSystem: 'one_based_inclusive',
      documentId,
      resourceUri: sequenceResourceUri(documentId),
      name: parsed.name || documentId,
      format: parsedFile.format,
      circular: parsed.circular,
      length: parsed.length ?? sequence.length,
      window: {
        start: requested.start,
        end: requested.end,
        length: slice.length,
        ...(requested.wraps ? { wraps: true } : {}),
      },
      sequenceIncluded: true,
      sequence: slice,
      sequencePreview: null,
      featureCount: parsedFile.features.length,
      features: parsedFile.features
        .filter((f) =>
          requested.wraps
            ?
              f.end >= requested.start || f.start <= requested.end
            : f.end >= requested.start && f.start <= requested.end
        )
        .slice(0, MAX_RESOURCE_FEATURES)
        .map((feature) => ({
          name: feature.displayName || feature.type,
          type: feature.type,
          start: feature.start,
          end: feature.end,
          direction: feature.direction,
        })),
    };
  }

  const sequenceIncluded = sequence.length <= MAX_INLINE_SEQUENCE_BP;
  const primerCount = parsedFile.features.filter(
    (feature) => feature.type === 'primer_bind' || feature.type === 'primer'
  ).length;

  return {
    exists: true,
    coordinateSystem: 'one_based_inclusive',
    documentId,
    resourceUri: sequenceResourceUri(documentId),
    name: parsed.name || documentId,
    format: parsedFile.format,
    circular: parsed.circular,
    length: parsed.length ?? sequence.length,
    sequenceIncluded,
    sequence: sequenceIncluded ? sequence : null,
    sequencePreview: sequenceIncluded ? null : sequence.slice(0, 1000),
    featureCount: parsedFile.features.length,
    features: parsedFile.features.slice(0, MAX_RESOURCE_FEATURES).map((feature) => ({
      name: feature.displayName || feature.type,
      type: feature.type,
      start: feature.start,
      end: feature.end,
      direction: feature.direction,
    })),
    primerCount,
  };
}

export function sequenceResourceUri(documentId: string): string {
  return `waypoint://sequence/${encodeURIComponent(documentId)}`;
}
