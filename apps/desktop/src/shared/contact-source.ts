import { z } from 'zod';
import type { ContactCamera, ContactProjection } from '@waypoint/genome-renderer/pure';

export const CONTACT_SOURCE_SCHEMA = 'dnaforge.contact-source.v1' as const;
export const CONTACT_MATRIX_SCHEMA = 'dnaforge.contact-matrix.v1' as const;
export const MAX_CONTACT_SOURCE_BYTES = 16 * 1_048_576;
export const MAX_CONTACT_SOURCE_CELLS = 100_000;

const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const coordinate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hexColor = z.string().regex(/^#[a-f0-9]{6}$/iu);
const referenceSchema = z
  .object({
    id: text,
    chrom: text,
    length: coordinate.positive(),
    label: text.optional(),
  })
  .strict();

export const contactSourceDescriptorSchema = z
  .object({
    schema: z.literal(CONTACT_SOURCE_SCHEMA),
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
    xReference: referenceSchema,
    yReference: referenceSchema,
  })
  .strict();

const continuousScaleSchema = z
  .object({
    kind: z.literal('continuous'),
    domain: z.tuple([z.number().finite(), z.number().finite()]),
    colors: z.array(hexColor).min(2).max(32),
    missingColor: hexColor,
    transform: z.enum(['linear', 'log10']),
    quantization: z.number().int().min(1).max(256).optional(),
  })
  .strict();
const categoricalScaleSchema = z
  .object({
    kind: z.literal('categorical'),
    colors: z.record(hexColor),
    missingColor: hexColor,
  })
  .strict();
const colorScaleSchema = z.discriminatedUnion('kind', [
  continuousScaleSchema,
  categoricalScaleSchema,
]);

export const contactSourceDocumentSchema = z
  .object({
    schema: z.literal(CONTACT_MATRIX_SCHEMA),
    id: text,
    label: text,
    unit: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim() === value),
    xReference: referenceSchema,
    yReference: referenceSchema,
    cells: z
      .array(
        z
          .object({
            id: text,
            start: coordinate,
            end: coordinate.positive(),
            targetStart: coordinate,
            targetEnd: coordinate.positive(),
            value: z.number().finite().nonnegative(),
          })
          .strict()
      )
      .max(MAX_CONTACT_SOURCE_CELLS),
    colorScale: colorScaleSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    document.cells.forEach((cell, index) => {
      if (ids.has(cell.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', index, 'id'],
          message: 'Contact cells require unique identities.',
        });
      }
      ids.add(cell.id);
      if (
        cell.end <= cell.start ||
        cell.end > document.xReference.length ||
        cell.targetEnd <= cell.targetStart ||
        cell.targetEnd > document.yReference.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', index],
          message: 'A contact cell interval is outside its axis reference.',
        });
      }
    });
    const scale = document.colorScale;
    if (scale.kind === 'continuous') {
      if (
        scale.domain[0] >= scale.domain[1] ||
        (scale.transform === 'log10' &&
          (scale.domain[0] <= 0 || document.cells.some((cell) => cell.value <= 0)))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['colorScale'],
          message: 'Choose an increasing color domain and values valid for its transform.',
        });
      }
    } else if (Object.keys(scale.colors).length > 256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colorScale', 'colors'],
        message: 'A categorical color scale supports at most 256 values.',
      });
    }
  });

export const contactCameraSchema = z
  .object({
    projectionId: z.string().min(1).max(1024),
    xStart: z.number().finite().nonnegative(),
    xEnd: z.number().finite().positive(),
    yStart: z.number().finite().nonnegative(),
    yEnd: z.number().finite().positive(),
  })
  .strict()
  .refine((camera) => camera.xEnd > camera.xStart && camera.yEnd > camera.yStart, {
    message: 'Contact camera intervals must increase on both axes.',
  });

export const contactProjectionViewStateSchema = z
  .object({
    kind: z.literal('contact-matrix'),
    project: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value)),
    source: contactSourceDescriptorSchema,
    camera: contactCameraSchema.optional(),
  })
  .strict()
  .superRefine((view, context) => {
    if (
      view.camera &&
      (view.camera.xEnd > view.source.xReference.length ||
        view.camera.yEnd > view.source.yReference.length)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['camera'],
        message: 'The contact camera must remain inside its axis references.',
      });
    }
  });

export type ContactSourceDescriptor = z.infer<typeof contactSourceDescriptorSchema>;
export type ContactSourceDocument = z.infer<typeof contactSourceDocumentSchema>;
export interface ContactProjectionViewState {
  readonly kind: 'contact-matrix';
  readonly project: string;
  readonly source: ContactSourceDescriptor;
  readonly camera?: ContactCamera;
}
export const contactSourceReadRequestSchema = z
  .object({ project: z.string().min(1).max(4096), source: contactSourceDescriptorSchema })
  .strict();
export type ContactSourceReadRequest = z.infer<typeof contactSourceReadRequestSchema>;
export interface ContactSourceReadResult {
  readonly projection: ContactProjection;
  readonly label: string;
  readonly unit: string;
  readonly revision: string;
  readonly path: string;
}

export function projectContactSource(
  document: ContactSourceDocument,
  source: ContactSourceDescriptor
): ContactProjection {
  for (const axis of ['xReference', 'yReference'] as const) {
    const expected = source[axis];
    const actual = document[axis];
    if (
      expected.id !== actual.id ||
      expected.chrom !== actual.chrom ||
      expected.length !== actual.length ||
      expected.label !== actual.label
    ) {
      throw new Error('The contact source axis references do not match the saved descriptor.');
    }
  }
  return {
    kind: 'contact-matrix',
    id: `${document.id}:${source.sha256}`,
    xReference: document.xReference,
    yReference: document.yReference,
    cells: document.cells,
    colorScale: document.colorScale,
  };
}
