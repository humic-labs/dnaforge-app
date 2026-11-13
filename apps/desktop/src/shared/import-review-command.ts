import { z } from 'zod';

const mapping = z
  .object({
    sourceColumn: z.string().min(1),
    mappedField: z.string().optional(),
    mappingMode: z.enum(['mapped', 'source_only', 'ignored']).optional(),
    confidence: z.enum(['user_overridden', 'agent_suggested']).optional(),
  })
  .strict();
const command = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inspect'),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-records-accepted'),
      recordIds: z.array(z.string().min(1)).min(1).max(10000),
      accepted: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('set-mappings'), mappings: z.array(mapping).max(1000) }).strict(),
  z
    .object({
      kind: z.literal('set-source-options'),
      sheetName: z.string().optional(),
      headerRowOverride: z.number().int().nonnegative().optional(),
      hasHeader: z.boolean().optional(),
      forcedKind: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve-duplicate'),
      recordId: z.string().min(1),
      entityId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve-link'),
      recordId: z.string().min(1),
      linkIndex: z.number().int().nonnegative(),
      endpoint: z.enum(['source', 'target']),
      entityId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('apply'), requestId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
]);
export const importReviewSchema = z
  .object({
    project: z.string().min(1).describe('Exact current project name or admitted root.'),
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('prepare'),
          destination: z.string().default('.').describe('Folder relative to the chosen project.'),
          source: z
            .object({
              fileName: z.string().min(1).max(1000),
              sourcePath: z
                .string()
                .min(1)
                .optional()
                .describe('Exact source path inside a currently admitted project.'),
              text: z
                .string()
                .max(2 * 1024 * 1024)
                .optional(),
              sheetName: z.string().optional(),
              headerRowOverride: z.number().int().nonnegative().optional(),
              hasHeader: z.boolean().optional(),
              forcedKind: z.string().min(1).max(128).optional(),
              externalRowKeyColumn: z.string().optional(),
              primerTmSettings: z
                .object({
                  userSetting: z.discriminatedUnion('kind', [
                    z
                      .object({
                        kind: z.literal('local'),
                        algorithm: z.enum(['santalucia98', 'santalucia-owczarzy']),
                      })
                      .strict(),
                    z
                      .object({
                        kind: z.literal('neb'),
                        prodcode: z.string().min(1).max(100),
                        polymerase: z.enum(['q5', 'phusion', 'onetaq', 'taq', 'longamp']),
                      })
                      .strict(),
                  ]),
                  userSettingIsExplicit: z.boolean(),
                  conditions: z
                    .object({
                      monovalentMm: z.number().finite().nonnegative(),
                      divalentMm: z.number().finite().nonnegative(),
                      dntpMm: z.number().finite().nonnegative(),
                    })
                    .strict(),
                  concNm: z.number().finite().positive(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('execute'),
          id: z.string().min(1),
          expectedRevision: z.string().min(1).optional(),
          command,
        })
        .strict(),
    ]),
  })
  .strict();

export type ImportReviewAgentInput = z.infer<typeof importReviewSchema>;
