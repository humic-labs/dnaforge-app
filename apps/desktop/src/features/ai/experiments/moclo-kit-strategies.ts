import { z } from 'zod';
import { asSchema } from 'ai';
import {
  callRendererTool,
  createConsoleRendererAuditSink,
} from '../../agent-bridge/public/renderer-bridge';
import {
  ALLOWED_RENDERER_TOOLS,
  type RendererToolName,
} from '../../agent-bridge/public/renderer-tools';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  resolveExplicitProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import {
  loadMocloSchemaDefinitions,
  saveMocloKit,
  type SaveMocloKitInput,
} from '../../design/public/moclo-schema-catalog';
import { saveMocloKitSchema, mocloKitAssemblySchema as templateSchema } from '../tools/moclo-kit';

const directSchema = saveMocloKitSchema;
const documentSchema = directSchema.omit({ project: true, kitId: true, expectedKitRevision: true });
const editSchema = z
  .object({
    expectedKitRevision: z.number().int().nonnegative(),
    changes: z
      .array(
        z.discriminatedUnion('op', [
          z
            .object({
              op: z.literal('set_details'),
              name: z.string().min(1),
              description: z.string().min(1),
            })
            .strict(),
          z
            .object({
              op: z.literal('upsert_member'),
              member: saveMocloKitSchema.shape.members.unwrap().element,
            })
            .strict(),
          z
            .object({
              op: z.literal('upsert_type'),
              partType: saveMocloKitSchema.shape.partTypes.unwrap().element,
            })
            .strict(),
          z.object({ op: z.literal('upsert_schema'), schema: templateSchema }).strict(),
        ])
      )
      .min(1),
  })
  .strict();

export type KitToolStrategy = 'existing' | 'structured' | 'document' | 'edits';
interface ExperimentalTool {
  description: string;
  schema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

export function createKitToolExperiment(project: string, kitId: string, strategy: KitToolStrategy) {
  if (!import.meta.env.DEV) throw new Error('Kit tool experiments require a development app.');
  if (!/^tool-compare-[a-z0-9-]+$/.test(kitId))
    throw new Error('Use an isolated experiment kit ID.');
  const root = resolveExplicitProjectRoot(
    writableProjectRoots(useWorkspaceStore.getState().folders),
    project
  );
  if (!root) throw new Error('Experiment project is missing or ambiguous.');
  const ownedDesignIds = new Set<string>();
  const read = async () => {
    const kit = (await loadMocloSchemaDefinitions(root.path)).find((item) => item.id === kitId);
    return kit ? { exists: true, kit } : { exists: false, expectedKitRevision: 0 };
  };
  const save = async (input: SaveMocloKitInput) => {
    if (input.kitId !== kitId || input.projectRoot !== root.path)
      throw new Error('Wrong experiment target.');
    const result = await saveMocloKit(input);
    return { status: 'saved', kitId: result.kitId, kitRevision: result.kitRevision };
  };
  const tools: Record<string, ExperimentalTool> = {};
  if (strategy === 'existing') {
    const names: RendererToolName[] = [
      'get_moclo_kit',
      'save_moclo_kit',
      'create_design',
      'get_design',
      'set_golden_gate_schema',
      'save_moclo_schema',
    ];
    for (const name of names) {
      const original = ALLOWED_RENDERER_TOOLS[name];
      tools[name] = {
        description: original.description,
        schema: original.inputSchema,
        execute: async (input) => {
          const args = input as Record<string, unknown>;
          if (args.kitId && args.kitId !== kitId) throw new Error('Wrong experiment kit.');
          if (args.designId && !ownedDesignIds.has(String(args.designId)))
            throw new Error('Not an experiment assembly.');
          if (name === 'create_design' && args.name !== kitId)
            throw new Error('Name the preview assembly with the experiment kit ID.');
          const response = await callRendererTool(
            {
              tool_name: name,
              args,
              agent_identity: 'fixture-tool-comparison',
              action_id: crypto.randomUUID(),
            },
            {
              folders: [root],
              agentCapabilities: [
                'read-workspace',
                'read-sequences',
                'write-workspace',
                'create-entity',
                'modify-tabs',
                'edit-assembly',
              ],
              auditSink: createConsoleRendererAuditSink(),
            }
          );
          if (!response.ok) throw new Error(response.error.message);
          const result = response.result as Record<string, unknown>;
          if (name === 'create_design' && typeof result.designId === 'string')
            ownedDesignIds.add(result.designId);
          return result;
        },
      };
    }
  } else {
    tools.read_kit = {
      description:
        'Read the current experiment kit, including its revision, members, types and schemas. Missing means revision 0.',
      schema: z.object({}).strict(),
      execute: read,
    };
    if (strategy === 'structured') {
      tools.save_kit = {
        description:
          'Create/update the kit and its reusable schemas directly. No assembly is needed. Add/update members, types and schemas by ID; omitted items are preserved. Use the current kit revision (0 for new). Package names are resolved by the app.',
        schema: directSchema,
        execute: async (input) => {
          const { project: requestedProject, ...update } = directSchema.parse(input);
          const selected = resolveExplicitProjectRoot([root], requestedProject);
          if (!selected) throw new Error('Wrong experiment project.');
          return save({ ...update, projectRoot: selected.path });
        },
      };
    } else if (strategy === 'document') {
      tools.write_kit_document = {
        description:
          'Save a JSON kit document. No assembly needed. Document shape: ' +
          JSON.stringify(asSchema(documentSchema).jsonSchema) +
          '. Add/update entries by ID; omitted entries are preserved. The app supplies package names and validates before writing.',
        schema: z
          .object({
            expectedKitRevision: z.number().int().nonnegative(),
            content: z.string().min(1).describe('JSON kit document'),
          })
          .strict(),
        execute: async (input) => {
          const { expectedKitRevision, content } = input as {
            expectedKitRevision: number;
            content: string;
          };
          return save({
            ...documentSchema.parse(JSON.parse(content)),
            expectedKitRevision,
            projectRoot: root.path,
            kitId,
          });
        },
      };
    } else {
      tools.edit_kit = {
        description:
          'Create/update a kit with small edits. New kits need set_details. Types, members and schemas are upserted by ID; other data is preserved. Submit related changes together; no assembly is needed.',
        schema: editSchema,
        execute: async (input) => {
          const parsed = editSchema.parse(input);
          const update: SaveMocloKitInput = {
            projectRoot: root.path,
            kitId,
            expectedKitRevision: parsed.expectedKitRevision,
          };
          for (const change of parsed.changes) {
            switch (change.op) {
              case 'set_details':
                update.name = change.name;
                update.description = change.description;
                break;
              case 'upsert_member':
                (update.members ??= []).push(change.member);
                break;
              case 'upsert_type':
                (update.partTypes ??= []).push(change.partType);
                break;
              case 'upsert_schema':
                (update.assemblySchemas ??= []).push(change.schema);
                break;
            }
          }
          return save(update);
        },
      };
    }
  }
  return {
    definitions: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        { description: tool.description, inputSchema: asSchema(tool.schema).jsonSchema },
      ])
    ),
    read,
    ownedDesignIds,
    execute: async (name: string, input: unknown) => {
      const tool = tools[name];
      if (!tool) throw new Error('Tool unavailable in this strategy: ' + name);
      return tool.execute(tool.schema.parse(input));
    },
  };
}
