import { z } from 'zod';
import {
  reverseComplement,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';

const sourcePartSchema = z
  .object({
    kind: z.literal('source'),
    documentId: z.string().min(1).max(200),
    start: z.number().int().positive().describe('1-indexed inclusive start in the source.'),
    end: z
      .number()
      .int()
      .positive()
      .describe('1-indexed inclusive end in the source; must be at or after start.'),
    strand: z.union([z.literal(1), z.literal(-1)]).default(1),
  })
  .strict();
const literalPartSchema = z
  .object({
    kind: z.literal('literal'),
    sequence: z
      .string()
      .min(1)
      .max(10_000)
      .describe('Explicit short synthetic DNA, using IUPAC DNA bases.'),
    label: z.string().min(1).max(200),
  })
  .strict();
export const sequenceProductPartSchema = z.discriminatedUnion('kind', [
  sourcePartSchema,
  literalPartSchema,
]);
export const createSequenceProductSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe('Project name; required when multiple projects are open.'),
    name: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Name of the new planned molecule; choose a distinct name for each construction intermediate.'
      ),
    directory: z
      .string()
      .min(1)
      .default('sequences')
      .describe('Project-relative destination directory.'),
    circular: z.boolean().default(false),
    parts: z
      .array(sequenceProductPartSchema)
      .min(1)
      .max(256)
      .describe(
        'Parts in exact product order. Source ranges use accepted DNA sequence or primer IDs returned by import_sequence or list_scientific_objects, with 1-indexed inclusive coordinates. Ranges cannot wrap; split an origin-crossing range explicitly. Use short literal parts only for explicitly specified synthetic DNA.'
      ),
  })
  .strict();

export type SequenceProductPart = z.infer<typeof sequenceProductPartSchema>;
export const sequenceProductCreationSchema = z
  .object({
    schema: z.literal('dnaforge.sequence-product-creation.v1'),
    circular: z.boolean(),
    parts: z
      .array(
        z.discriminatedUnion('kind', [
          sourcePartSchema
            .extend({
              revision: z
                .object({
                  resourceRevisionId: z.string().regex(/^rr_[a-f0-9]{64}$/),
                  workspaceVersionId: z.string().regex(/^wv_[a-f0-9]{64}$/),
                  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
                })
                .strict(),
            })
            .strict(),
          literalPartSchema,
        ])
      )
      .min(1)
      .max(256),
  })
  .strict();
export type SequenceProductCreation = z.infer<typeof sequenceProductCreationSchema>;

function dna(input: string): string {
  const normalized = input.replace(/\s/gu, '').toUpperCase();
  if (!normalized || !/^[ACGTRYSWKMBDHVN]+$/u.test(normalized))
    throw new Error('Sequence products require nonempty IUPAC DNA.');
  return normalized;
}

export function primerDnaSource(id: string, name: string, sequence: string): AnnotatedSequence {
  const bases = dna(sequence);
  return {
    id,
    name,
    sequence: bases,
    length: bases.length,
    circular: false,
    annotations: [{ name, type: 'primer_bind', start: 1, end: bases.length, direction: 1 }],
  };
}

export function composeSequenceProduct(
  name: string,
  circular: boolean,
  parts: readonly SequenceProductPart[],
  sources: ReadonlyMap<string, AnnotatedSequence>
): AnnotatedSequence {
  if (!parts.length || parts.length > 256)
    throw new Error('Choose between 1 and 256 product parts.');
  const chunks: string[] = [],
    annotations: Annotation[] = [];
  let length = 0;
  for (const part of parts) {
    let bases: string;
    if (part.kind === 'literal') {
      if (part.sequence.length > 10_000)
        throw new Error('Synthetic DNA parts are limited to 10,000 bases.');
      bases = dna(part.sequence);
      annotations.push({
        name: part.label,
        type: 'misc_feature',
        start: length + 1,
        end: length + bases.length,
        direction: 1,
      });
    } else {
      const source = sources.get(part.documentId);
      if (!source) throw new Error(`Sequence source is unavailable: ${part.documentId}`);
      if (
        !Number.isSafeInteger(part.start) ||
        !Number.isSafeInteger(part.end) ||
        part.start < 1 ||
        part.end < part.start ||
        part.end > source.sequence.length ||
        (part.strand !== 1 && part.strand !== -1)
      )
        throw new Error(`Invalid source range: ${part.documentId} ${part.start}..${part.end}`);
      const fragment = dna(source.sequence.slice(part.start - 1, part.end));
      bases = part.strand === -1 ? reverseComplement(fragment) : fragment;
      const point = (position: number) =>
        length + (part.strand === 1 ? position - part.start + 1 : part.end - position + 1);

      for (const annotation of source.annotations) {
        const ranges = annotation.segments?.length ? annotation.segments : [annotation];
        if (
          annotation.type === 'source' ||
          ranges.some(
            (range) => range.start < part.start || range.end > part.end || range.start > range.end
          )
        )
          continue;
        const mapped = ranges.map((range) => ({
          start: Math.min(point(range.start), point(range.end)),
          end: Math.max(point(range.start), point(range.end)),
        }));
        if (part.strand === -1) mapped.reverse();
        annotations.push({
          name: annotation.name,
          type: annotation.type,
          start: Math.min(...mapped.map((range) => range.start)),
          end: Math.max(...mapped.map((range) => range.end)),
          direction:
            annotation.direction === 0 ? 0 : ((annotation.direction * part.strand) as 1 | -1),
          ...(annotation.color ? { color: annotation.color } : {}),
          ...(annotation.label ? { label: annotation.label } : {}),
          ...(annotation.qualifiers ? { qualifiers: structuredClone(annotation.qualifiers) } : {}),
          ...(annotation.segments?.length ? { segments: mapped } : {}),
        });
      }
    }
    length += bases.length;
    if (length > 50_000_000) throw new Error('Sequence products are limited to 50 million bases.');
    chunks.push(bases);
  }
  return { id: name, name, sequence: chunks.join(''), length, circular, annotations };
}
