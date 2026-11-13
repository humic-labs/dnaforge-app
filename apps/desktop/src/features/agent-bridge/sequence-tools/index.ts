import { z } from 'zod';
import { toolSuccess } from '../public/tool-result';
import { loadSequenceDocumentBiologyFile } from '../../ai/public/tools/path-utils';
import { sequenceResourceUri } from '../../ai/public/tools/get-sequence';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';

export const SEQ_LIST_ANNOTATIONS_DESCRIPTION =
  'List saved sequence annotations by stable document identity across mounted projects, including documents with no open tab. Filter by name, gene symbol, locus tag, type or range with 1-based inclusive coordinates. Returns raw annotation indexes for structure drawer operations and pagination. Does not open or activate a window.';

export const seqListAnnotationsSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .describe(
        'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
      ),
    kind: z.string().min(1).max(100).optional(),
    filter: z
      .object({
        name: z.string().min(1).max(200).optional(),
        locusTag: z.string().min(1).max(200).optional(),
        range: z
          .object({
            start: z.number().int().min(1),
            end: z.number().int().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export const seqListAnnotationsOutputSchema = z
  .object({
    ok: z.literal(true),
    coordinateSystem: z.literal('one_based_inclusive'),
    documentId: z.string(),
    resourceUri: z.string(),
    format: z.enum(['genbank', 'fasta', 'gff3']),
    annotationCount: z.number().int().nonnegative(),
    matchCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    truncated: z.boolean(),
    hint: z.string().nullable(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    annotations: z.array(
      z
        .object({
          rawIndex: z.number().int().nonnegative(),
          name: z.string(),
          type: z.string(),
          range: z.object({ start: z.number(), end: z.number() }).strict(),
          start: z.number(),
          end: z.number(),
          direction: z.string().optional(),
          segments: z.array(z.object({ start: z.number(), end: z.number() }).strict()).nullable(),
          locusTag: z.string().nullable(),
          geneName: z.string().nullable(),
          dbXrefs: z.array(z.string()),
          qualifiers: z.record(z.string(), z.array(z.string())),
        })
        .strict()
    ),
  })
  .strict();

type FeatureLike = {
  displayName?: string;
  type: string;
  start: number;
  end: number;
  direction?: string;
  qualifiers?: Record<string, string[] | string>;
  segments?: Array<{ start: number; end: number }>;
};

function normalizeQualifiers(feature: FeatureLike): Record<string, string[]> {
  const qualifiers: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(feature.qualifiers ?? {})) {
    qualifiers[key] = Array.isArray(value) ? value.map(String) : [String(value)];
  }
  return qualifiers;
}

function qualifierValues(qualifiers: Record<string, string[]>, ...keys: string[]): string[] {
  return keys.flatMap((key) => qualifiers[key] ?? []);
}

function overlapsRange(feature: FeatureLike, range: { start: number; end: number }): boolean {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return feature.start <= end && feature.end >= start;
}

function featureMatches(
  feature: FeatureLike,
  rawIndex: number,
  args: z.infer<typeof seqListAnnotationsSchema>
): boolean {
  if (args.kind && feature.type.toLowerCase() !== args.kind.toLowerCase()) {
    return false;
  }

  const qualifiers = normalizeQualifiers(feature);
  const filter = args.filter;
  if (!filter) return true;

  if (filter.locusTag) {
    const wanted = filter.locusTag.toLowerCase();
    const locusTags = qualifierValues(qualifiers, 'locus_tag').map((value) => value.toLowerCase());
    if (!locusTags.includes(wanted)) return false;
  }

  if (filter.range && !overlapsRange(feature, filter.range)) {
    return false;
  }

  if (filter.name) {
    const needle = filter.name.toLowerCase();
    const haystack = [
      feature.displayName,
      feature.type,
      String(rawIndex),
      ...qualifierValues(qualifiers, 'gene', 'locus_tag', 'product', 'note', 'label'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

export async function handleSeqListAnnotations(
  args: unknown,
  context: { folders: WorkspaceFolder[] }
) {
  const parsedArgs = seqListAnnotationsSchema.parse(args);
  const loaded = await loadSequenceDocumentBiologyFile(parsedArgs.documentId, context.folders);
  const parsedFile = loaded.biology;
  const features = parsedFile.features as FeatureLike[];
  const matches = features
    .map((feature, rawIndex) => ({ feature, rawIndex }))
    .filter(({ feature, rawIndex }) => featureMatches(feature, rawIndex, parsedArgs));
  const page = matches.slice(parsedArgs.offset, parsedArgs.offset + parsedArgs.limit);
  const annotations = page.map(({ feature, rawIndex }) => {
    const qualifiers = normalizeQualifiers(feature);
    const locusTag = qualifiers.locus_tag?.[0] ?? null;
    const geneName = qualifiers.gene?.[0] ?? null;
    const dbXrefs = qualifiers.db_xref ?? [];
    return {
      rawIndex,
      name: feature.displayName || feature.type,
      type: feature.type,
      range: { start: feature.start, end: feature.end },
      start: feature.start,
      end: feature.end,
      direction: feature.direction,
      segments: feature.segments ?? null,
      locusTag,
      geneName,
      dbXrefs,
      qualifiers,
    };
  });
  const returned = annotations.length;
  const total = matches.length;
  const truncated = parsedArgs.offset + returned < total;

  return toolSuccess({
    documentId: loaded.documentId,
    coordinateSystem: 'one_based_inclusive',
    resourceUri: sequenceResourceUri(loaded.documentId),
    format: parsedFile.format,
    annotationCount: features.length,
    matchCount: matches.length,
    total,
    returned,
    truncated,
    hint: truncated
      ? `More annotations are available; call seq_list_annotations with offset ${
          parsedArgs.offset + returned
        }.`
      : null,
    offset: parsedArgs.offset,
    limit: parsedArgs.limit,
    annotations,
  });
}
