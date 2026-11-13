import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { GOLDEN_GATE_ENZYME_NAMES } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';

export const goldenGateRoleTermSchema = z
  .object({
    id: z.string().min(1).optional().describe('Optional stable ontology or kit term ID.'),
    label: z.string().min(1).describe('Open-ended biological role label.'),
  })
  .strict();

const goldenGateSchemaOriginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('custom') }).strict(),
  z
    .object({
      type: z.literal('kit'),
      kitId: z.string().min(1),
      kitName: z.string().min(1),
      schemaId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('imported'),
      sourceLabel: z.string().min(1),
    })
    .strict(),
]);

export const setGoldenGateSchemaSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Golden Gate design id returned by get_design, or waypoint://design/{id} URI.'),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact design version last read from get_design. Stale writes are refused.'),
    schema: z
      .object({
        id: z.string().min(1).describe('Stable schema identity within this design.'),
        name: z.string().min(1).describe('User-facing schema name.'),
        revision: z.number().int().positive(),
        origin: goldenGateSchemaOriginSchema,
        enzyme: z.enum(GOLDEN_GATE_ENZYME_NAMES),
        slots: z
          .array(
            z
              .object({
                id: z.string().min(1).describe('Stable identity for this schema position.'),
                label: z.string().min(1).describe('Concise position label.'),
                outgoingOverhang: z
                  .string()
                  .nullable()
                  .describe(
                    'Concrete outgoing sticky-end sequence, or null when this junction is intentionally unconstrained.'
                  ),
                preferredRoles: z
                  .array(goldenGateRoleTermSchema)
                  .describe(
                    'Zero or more expected biological roles. These guide ranking and warnings; they do not override physical compatibility.'
                  ),
              })
              .strict()
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

type SetGoldenGateSchemaInput = z.infer<typeof setGoldenGateSchemaSchema>;

function normalizeDesignId(input: string): string {
  if (!input.startsWith('waypoint://')) return input;
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'waypoint:' && parsed.hostname === 'design') {
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return input;
  }
  return input;
}

export function createSetGoldenGateSchemaTool() {
  return resultTool({
    description:
      'Define or revise the ordered schema for a Golden Gate assembly. A schema contains positions, ' +
      'the outgoing overhang after each position, and optional preferred biological roles. A null ' +
      'overhang is an honest unconstrained junction. Kit origin is provenance only: it never prevents ' +
      'compatible parts from other kits from being considered. Changing the schema starts over with empty slots; ' +
      'a populated draft returns confirmation-required so the user can change it in the assembly pane. Read get_design first and pass its exact version. ' +
      'This is also the preview step for reusable schema authoring: show the layout in the existing assembly pane, then use save_moclo_schema after user approval.',
    inputSchema: setGoldenGateSchemaSchema,
    execute: async (input: SetGoldenGateSchemaInput, context?: { toolCallId?: string }) =>
      runDesignTool('SET_GOLDEN_GATE_SCHEMA_FAILED', async (effects) => {
        const designId = normalizeDesignId(input.designId);
        const before = useDesignStore.getState().designs[designId];
        if (!before) {
          return designToolFailure(
            'SET_GOLDEN_GATE_SCHEMA_FAILED',
            {
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
              designId,
              currentVersion: null,
            },
            effects
          );
        }

        effects.attemptedMutation();
        const result = useDesignStore
          .getState()
          .setGoldenGateSchema(designId, input.schema, input.expectedDesignVersion);
        const current = useDesignStore.getState().designs[designId] ?? before;

        if (result.status === 'rejected') {
          effects.unchanged();
          return designToolFailure(
            'SET_GOLDEN_GATE_SCHEMA_FAILED',
            {
              ...result,
              error: result.message,
              designId,
              currentVersion: current.version,
            },
            effects
          );
        }

        const changed = result.status === 'applied';
        if (changed) effects.changed({ kind: 'design-schema-changed', designId });
        else effects.unchanged();
        const projectedSchema = current.goldenGateSchema ?? input.schema;
        return toolSuccess({
          status: result.status,
          designId,
          previousVersion: before.version,
          designVersion: current.version,
          schema: projectedSchema,
          slotCount: projectedSchema.slots.length,
          revalidationRequired: changed,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_golden_gate_schema',
            effect: 'set_golden_gate_schema',
            designId,
            beforeVersion: before.version,
            afterVersion: current.version,
            changed,
            expected: {
              schemaId: projectedSchema.id,
              schemaRevision: projectedSchema.revision,
              slotCount: projectedSchema.slots.length,
            },
          }),
        });
      }),
  });
}

export const setGoldenGateSchemaTool = createSetGoldenGateSchemaTool();
