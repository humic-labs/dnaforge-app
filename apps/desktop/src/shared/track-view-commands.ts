import { z } from 'zod';
import type { TrackViewCommand, TrackViewCommandResult } from '@waypoint/domain-services';
import { HEX_COLOR_PATTERN } from './published-schema-patterns';

const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes('\0'));
const project = text;
const path = text;
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path }).strict(),
  z
    .object({
      kind: z.literal('url'),
      url: z
        .string()
        .trim()
        .url()
        .max(2000)
        .refine((value) => {
          const url = new URL(value);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        }),
    })
    .strict(),
]);
export const trackViewCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('references') }).strict(),
  z.object({ operation: z.literal('inspect'), project, path }).strict(),
  z
    .object({
      operation: z.literal('create'),
      project,
      path,
      referenceId: text,
      requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
      name: z.string().trim().min(1).max(200),
      viewport: z
        .object({
          chrom: text,
          start0: z.number().int().nonnegative(),
          end0: z.number().int().positive(),
        })
        .strict()
        .refine((value) => value.start0 < value.end0)
        .optional(),
      tracks: z
        .array(
          z
            .object({
              source,
              format: z.enum(['bigwig', 'bigbed']),
              label: z.string().trim().min(1).max(200).optional(),
              color: z.string().regex(HEX_COLOR_PATTERN).optional(),
              heightPx: z.number().int().min(32).max(2048).optional(),
              visible: z.boolean().optional(),
              range: z
                .object({ min: z.number().finite(), max: z.number().finite() })
                .strict()
                .refine((value) => value.min < value.max)
                .optional(),
            })
            .strict()
        )
        .max(64),
    })
    .strict(),
]) satisfies z.ZodType<TrackViewCommand>;

export const trackViewToolRequestSchema = trackViewCommandSchema.options[2]
  .partial()
  .extend({ operation: z.enum(['references', 'inspect', 'create']) })
  .transform((input, context) => {
    const result = trackViewCommandSchema.safeParse(input);
    if (result.success) return result.data;
    for (const issue of result.error.issues) context.addIssue(issue);
    return z.NEVER;
  });

const savedTrackViewResultSchema = z.object({
  ok: z.literal(true),
  documentId: text,
  name: text,
  path,
  revision: text,
  referenceId: text,
  viewport: z.object({ start0: z.number(), end0: z.number() }),
  tracks: z.array(
    z.object({
      trackId: text,
      label: z.string(),
      visible: z.boolean(),
      color: z.string(),
      heightPx: z.number(),
    })
  ),
  warning: z.string().optional(),
});

export const trackViewCommandResultSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ok: z.literal(true),
      operation: z.literal('references'),
      references: z.array(
        z.object({
          id: text,
          name: z.string(),
          organism: z.string(),
          chromosomes: z.array(z.object({ chrom: text, length: z.number() })),
        })
      ),
    })
    .strict(),
  savedTrackViewResultSchema.extend({ operation: z.literal('inspect') }).strict(),
  savedTrackViewResultSchema.extend({ operation: z.literal('create') }).strict(),
]) satisfies z.ZodType<TrackViewCommandResult>;
