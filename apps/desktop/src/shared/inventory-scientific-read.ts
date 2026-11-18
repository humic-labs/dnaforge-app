import { z } from 'zod';
import {
  parseInventoryScientificWork,
  type InventoryScientificWork,
} from '@waypoint/domain-services';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()) && !value.includes('\0'));
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value) => value as `sha256:${string}`);
export const inventoryScientificWorkContextSchema = z
  .object({ kind: z.enum(['notebook-page', 'protocol-run']), entityId: text(1000) })
  .strict();
export const inventoryScientificWorkCursorSchema = z
  .object({
    querySha256: digest,
    revision,
    after: z
      .object({
        at: revision,
        workId: z.string().regex(/^scientific-work:[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export const inventoryScientificWorksForContextRequestSchema = z
  .object({
    project: text(4096),
    inventoryId: text(256),
    context: inventoryScientificWorkContextSchema,
    limit: z.number().int().min(1).max(50).optional(),
    cursor: inventoryScientificWorkCursorSchema.optional(),
  })
  .strict();
export type InventoryScientificWorkCursor = z.infer<typeof inventoryScientificWorkCursorSchema>;
export type InventoryScientificWorksForContextRequest = z.infer<
  typeof inventoryScientificWorksForContextRequestSchema
>;
export type InventoryScientificWorksForContextRead =
  | {
      readonly kind: 'ready';
      readonly projectId: string;
      readonly inventoryId: string;
      readonly context: InventoryScientificWorksForContextRequest['context'];
      readonly revision: number;
      readonly works: readonly InventoryScientificWork[];
      readonly nextCursor: InventoryScientificWorkCursor | null;
    }
  | {
      readonly kind: 'inventory-absent';
      readonly projectId: string;
      readonly inventoryId: string;
      readonly context: InventoryScientificWorksForContextRequest['context'];
    }
  | {
      readonly kind: 'unavailable';
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

const scientificWork = z.unknown().transform((value, context) => {
  try {
    return parseInventoryScientificWork(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid scientific work record.',
    });
    return z.NEVER;
  }
});
export const inventoryScientificWorksForContextReadSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('ready'),
        projectId: text(1024),
        inventoryId: text(256),
        context: inventoryScientificWorkContextSchema,
        revision,
        works: z.array(scientificWork).max(50),
        nextCursor: inventoryScientificWorkCursorSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('inventory-absent'),
        projectId: text(1024),
        inventoryId: text(256),
        context: inventoryScientificWorkContextSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('unavailable'),
        code: text(256),
        message: text(4096),
        retryable: z.boolean(),
      })
      .strict(),
  ])
  .transform((result, context) => {
    if (result.kind !== 'ready') return result;
    const ids = new Set<string>();
    for (const [index, work] of result.works.entries()) {
      const source = work.context;
      const previous = result.works[index - 1];
      if (
        ids.has(work.id) ||
        source.projectId !== result.projectId ||
        source.workspaceScope !== result.projectId ||
        source.kind !== result.context.kind ||
        (source.kind === 'notebook-page' ? source.pageId : source.entityId) !==
          result.context.entityId ||
        (previous && (previous.at > work.at || (previous.at === work.at && previous.id >= work.id)))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Scientific work page scope or order is invalid.',
        });
      ids.add(work.id);
    }
    if (result.nextCursor) {
      const last = result.works.at(-1);
      if (
        !last ||
        result.nextCursor.revision !== result.revision ||
        result.nextCursor.after.workId !== last.id ||
        result.nextCursor.after.at !== last.at
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Scientific work continuation is invalid.',
        });
    }
    return result;
  });
