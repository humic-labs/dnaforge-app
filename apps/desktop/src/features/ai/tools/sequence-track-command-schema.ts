import { z } from 'zod';
import { ANNOTATION_TRACK_LAYOUT_SCHEMA, FEATURE_KINDS } from '@waypoint/genome-data/annotation-catalog';

const id = z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,127}$/);
const presentation = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  rowHeightPx: z.number().min(4).max(64).nullable(),
  maxRows: z.number().int().min(1).max(64).nullable(),
}).strict();
const filter = z.object({ minScore: z.number().finite().nullable() }).strict();
export const sequenceTrackBindingSchema = z.object({
  id,
  kind: z.enum(FEATURE_KINDS),
  sourceId: id,
  visualizationId: id,
  visible: z.boolean(),
  label: z.string().max(200).nullable(),
  presentation,
  filter,
}).strict();
export const sequenceTrackLayoutSchema = z.object({
  schema: z.literal(ANNOTATION_TRACK_LAYOUT_SCHEMA),
  assembly: z.string().min(1).max(64),
  tracks: z.array(sequenceTrackBindingSchema).max(64),
}).strict();

export const sequenceTrackCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set-layout'),
    layout: sequenceTrackLayoutSchema,
  }).strict(),
  z.object({ kind: z.literal('clear-layout') }).strict(),
  z.object({ kind: z.literal('add-track'), binding: sequenceTrackBindingSchema, index: z.number().int().min(0).optional() }).strict(),
  z.object({ kind: z.literal('remove-track'), trackId: id }).strict(),
  z.object({ kind: z.literal('set-source'), trackId: id, sourceId: id }).strict(),
  z.object({ kind: z.literal('set-visualization'), trackId: id, visualizationId: id }).strict(),
  z.object({ kind: z.literal('set-visibility'), trackId: id, visible: z.boolean() }).strict(),
  z.object({ kind: z.literal('set-presentation'), trackId: id, presentation: presentation.partial() }).strict(),
  z.object({ kind: z.literal('set-filter'), trackId: id, filter: filter.partial() }).strict(),
  z.object({ kind: z.literal('move-track'), trackId: id, toIndex: z.number().int().min(0) }).strict(),
]);
