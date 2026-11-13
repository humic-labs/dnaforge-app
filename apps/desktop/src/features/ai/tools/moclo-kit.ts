import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveExplicitProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import { loadMocloSchemaDefinitions, saveMocloKit } from '../../design/public/moclo-schema-catalog';
import { mocloAssemblySchemaOptions } from '../../design/public/moclo-kit-definition';
import { goldenGateRoleTermSchema, setGoldenGateSchemaSchema } from './set-golden-gate-schema';
import { CATALOG_ID_PATTERN } from '../../../shared/published-schema-patterns';

export const mocloKitAssemblySchema = setGoldenGateSchemaSchema.shape.schema
  .pick({ id: true, name: true, enzyme: true, slots: true })
  .extend({
    id: setGoldenGateSchemaSchema.shape.schema.shape.id.describe(
      'Stable schema identity within this kit.'
    ),
    description: z.string().min(1),
    topology: z.enum(['linear', 'circular']),
  })
  .strict();

const projectSchema = z
  .string()
  .min(1)
  .describe(
    'Explicit project name or root from get_workspace. Ambiguous names are refused; folder order never chooses the project.'
  );
const kitIdSchema = z.string().regex(CATALOG_ID_PATTERN);

export const getMocloKitSchema = z
  .object({
    project: projectSchema,
    kitId: kitIdSchema
      .optional()
      .describe(
        'Omit to list kits and revisions; provide an ID to inspect its full members, roles, citations and schemas.'
      ),
  })
  .strict();

export const saveMocloKitSchema = z
  .object({
    project: projectSchema,
    kitId: kitIdSchema,
    expectedKitRevision: z
      .number()
      .int()
      .nonnegative()
      .describe('Revision returned by get_moclo_kit, or 0 for a new kit.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Required for a new kit. Omit to preserve the current name.'),
    description: z
      .string()
      .min(1)
      .optional()
      .describe('Purpose of this kit. Required for a new kit.'),
    citations: z
      .array(
        z
          .object({
            label: z.string().min(1),
            doi: z.string().min(1).optional(),
            pmid: z.string().min(1).optional(),
            url: z.string().min(1).optional(),
          })
          .strict()
      )
      .optional()
      .describe(
        'Supporting kit documentation. Omit to preserve existing citations; supplied list replaces citations.'
      ),
    partTypes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            roleTerms: z.array(goldenGateRoleTermSchema),
          })
          .strict()
      )
      .optional()
      .describe(
        'Add or update types by ID. Declare only roles supported by annotations/documentation or confirmed by the user. Unspecified types are preserved.'
      ),
    members: z
      .array(
        z
          .object({
            sequencePackageId: z
              .string()
              .min(1)
              .describe(
                'Stable managed sequence document/package ID from import_sequence or get_sequence, never a file path.'
              ),
            partTypeId: z
              .string()
              .min(1)
              .nullable()
              .optional()
              .describe(
                'Declared type ID. Omit to preserve an existing assignment; null explicitly clears it.'
              ),
          })
          .strict()
      )
      .optional()
      .describe(
        'Add or update members by package ID. Names come from the actual packages. Unspecified members are preserved.'
      ),
    assemblySchemas: z
      .array(mocloKitAssemblySchema)
      .optional()
      .describe(
        'Add or update reusable layouts by ID in the same save as the kit. Omitted layouts are preserved. No preview assembly is required. Each slot defines its outgoing overhang; the last slot closes a circular layout.'
      ),
    removeMemberPackageIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Remove these package IDs from this kit only. Never deletes source sequences. Cannot also update the same member.'
      ),
    removePartTypeIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Remove these declared types. Reassign, clear or remove their members in the same save; dangling type references are rejected.'
      ),
    removeSchemaIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Remove these reusable schemas by their IDs within this kit. Existing assemblies retain their saved schemas; removed templates stay removed on reload.'
      ),
  })
  .strict();

interface KitToolDependencies {
  loadDefinitions: typeof loadMocloSchemaDefinitions;
  saveKit: typeof saveMocloKit;
}
const defaultDependencies: KitToolDependencies = {
  loadDefinitions: loadMocloSchemaDefinitions,
  saveKit: saveMocloKit,
};

function projectRoot(folders: readonly WorkspaceFolder[], project: string) {
  const root = resolveExplicitProjectRoot(writableProjectRoots(folders), project);
  if (!root)
    throw new Error(
      `Project not found, not writable or ambiguous: ${project}. Use an explicit project root from get_workspace.`
    );
  return root.path;
}

export function createGetMocloKitTool(
  folders: readonly WorkspaceFolder[],
  dependencies: KitToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Inspect MoClo kits in an explicitly selected project without creating an assembly. Omit kitId to list available kits and revisions; supply it to read declared package members, roles, citations and schemas. Templates can exist without imported parts. Use the revision with save_moclo_kit.',
    inputSchema: getMocloKitSchema,
    execute: async (input: z.infer<typeof getMocloKitSchema>) =>
      runDesignTool('MOCLO_KIT_FAILED', async (effects) => {
        try {
          const definitions = await dependencies.loadDefinitions(
            projectRoot(folders, input.project)
          );
          if (input.kitId) {
            const kit = definitions.find((item) => item.id === input.kitId);
            if (!kit)
              return designToolFailure(
                'MOCLO_KIT_FAILED',
                {
                  ok: false as const,
                  status: 'rejected' as const,
                  error: `Kit ${input.kitId} is not defined in this project.`,
                },
                effects
              );
            return toolSuccess({ status: 'ready' as const, kit });
          }
          return toolSuccess({
            status: 'ready' as const,
            kits: definitions.map((kit) => ({
              id: kit.id,
              name: kit.name,
              revision: kit.revision,
              description: kit.description,
              memberCount: kit.members.length,
              schemaCount: mocloAssemblySchemaOptions(kit).length,
            })),
          });
        } catch (error) {
          return designToolFailure(
            'MOCLO_KIT_FAILED',
            {
              ok: false as const,
              status: 'rejected' as const,
              error: error instanceof Error ? error.message : String(error),
            },
            effects
          );
        }
      }),
  });
}

export function createSaveMocloKitTool(
  folders: readonly WorkspaceFolder[],
  dependencies: KitToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Create or update a MoClo kit, including reusable assemblySchemas, in one save to an explicitly selected project. No preview assembly is required. Import managed sequence packages first and record only supported biological roles. Read get_moclo_kit before updating. Unspecified members, types, schemas and recipes are preserved; DNA, primers and assemblies are unchanged. Member names come from packages; actual member overhangs come from digest tools. Schema overhangs define the desired layout. To save a layout from an existing assembly instead, use save_moclo_schema.',
    inputSchema: saveMocloKitSchema,
    execute: async (input: z.infer<typeof saveMocloKitSchema>) =>
      runDesignTool('MOCLO_KIT_FAILED', async (effects) => {
        try {
          const { project, ...update } = input;
          effects.attemptedMutation();
          const result = await dependencies.saveKit({
            ...update,
            projectRoot: projectRoot(folders, project),
          });
          return toolSuccess({
            status: 'saved' as const,
            kitId: result.kitId,
            kitRevision: result.kitRevision,
            contentHash: result.contentHash,
          });
        } catch (error) {
          return designToolFailure(
            'MOCLO_KIT_FAILED',
            {
              ok: false as const,
              status: 'rejected' as const,
              error: error instanceof Error ? error.message : String(error),
            },
            effects
          );
        }
      }),
  });
}
