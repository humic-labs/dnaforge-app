import { z } from 'zod';
import type { GenomeComparison } from '@waypoint/genome-data';
import type { ComparisonCamera } from '@waypoint/genome-renderer/pure';

export const COMPARISON_SOURCE_SCHEMA = 'dnaforge.comparison-source.v1' as const;
export const MAX_COMPARISON_SOURCE_BYTES = 16 * 1_048_576;

const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const referenceSchema = z
  .object({
    id: text.refine((value) => !/\s/u.test(value)),
    chrom: text.refine((value) => !/\s/u.test(value)),
    length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    label: text.optional(),
  })
  .strict()
  .refine((reference) => reference.id === reference.chrom, {
    message: 'A comparison axis must use its exact chromosome accession as its reference ID.',
  });

export const comparisonSourceDescriptorSchema = z
  .object({
    schema: z.literal(COMPARISON_SOURCE_SCHEMA),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
          value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
        'Choose a normalized file path relative to its owning project.'
      ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    targetReference: referenceSchema,
    queryReference: referenceSchema,
  })
  .strict();

export const comparisonCameraSchema = z
  .object({
    projectionId: z.string().min(1).max(1024),
    startColumn: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endColumn: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((camera) => camera.endColumn > camera.startColumn, {
    message: 'A comparison camera requires an increasing alignment-column interval.',
  });

export function comparisonSourceProjectionId(source: ComparisonSourceDescriptor): string {
  return `comparison:${source.sha256}`;
}

export const comparisonProjectionViewStateSchema = z
  .object({
    kind: z.literal('aligned-genomes'),
    project: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value)),
    source: comparisonSourceDescriptorSchema,
    camera: comparisonCameraSchema.optional(),
  })
  .strict()
  .refine(
    (view) =>
      !view.camera || view.camera.projectionId === comparisonSourceProjectionId(view.source),
    { message: 'The comparison camera must belong to its exact source revision.', path: ['camera'] }
  );

export type ComparisonSourceDescriptor = z.infer<typeof comparisonSourceDescriptorSchema>;
export interface ComparisonProjectionViewState {
  readonly kind: 'aligned-genomes';
  readonly project: string;
  readonly source: ComparisonSourceDescriptor;
  readonly camera?: ComparisonCamera;
}
export const comparisonSourceReadRequestSchema = z
  .object({ project: z.string().min(1).max(4096), source: comparisonSourceDescriptorSchema })
  .strict();
export type ComparisonSourceReadRequest = z.infer<typeof comparisonSourceReadRequestSchema>;
export interface ComparisonSourceReadResult {
  readonly comparison: GenomeComparison;
  readonly projectionId: string;
  readonly label: string;
  readonly revision: string;
  readonly path: string;
}
