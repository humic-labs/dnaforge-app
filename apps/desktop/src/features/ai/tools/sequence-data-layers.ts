import { z } from 'zod';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import {
  sequenceDataLayerCommandSchema,
  sequenceDataLayerIdSchema,
  sequenceDataLayerPresentationSchema,
  SEQUENCE_DATA_LAYERS_CHANGED,
  type SequenceDataLayerCommand,
  type PublishedSequenceDataLayer,
} from '../../../shared/sequence-data-layer';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  captureSequenceDataLayerViews,
  selectSequenceDataLayerView,
} from '../../sequence/public/sequence-data-layer-view-commands';

const paletteIds = Object.keys(SCIENTIFIC_COLOR_PALETTES) as [
  keyof typeof SCIENTIFIC_COLOR_PALETTES,
  ...(keyof typeof SCIENTIFIC_COLOR_PALETTES)[],
];
const colorScaleSchema = sequenceDataLayerPresentationSchema.shape.style.shape.colorScale;
const namedColorScaleSchema = colorScaleSchema
  .innerType()
  .omit({ colors: true })
  .extend({ paletteId: z.enum(paletteIds) })
  .strict()
  .transform(({ paletteId, ...scale }) => ({
    ...scale,
    colors: [...SCIENTIFIC_COLOR_PALETTES[paletteId].colors],
  }));
const toolPresentationSchema = sequenceDataLayerPresentationSchema.extend({
  style: sequenceDataLayerPresentationSchema.shape.style.extend({
    colorScale: z.union([colorScaleSchema, namedColorScaleSchema]),
  }),
});

export const sequenceDataLayersToolSchema = sequenceDataLayerCommandSchema.options[0]
  .partial()
  .extend({
    operation: z.enum(['target', 'create', 'inspect', 'list']),
    id: sequenceDataLayerIdSchema.optional(),
    presentation: toolPresentationSchema.optional(),
  })
  .transform((input, context) => {
    const parsed = sequenceDataLayerCommandSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) context.addIssue(issue);
    return z.NEVER;
  });

export const sequenceDataLayersOutputSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['target', 'published', 'needs-input', 'listed']),
  data: z.record(z.unknown()),
});

function reusableSource(layer: PublishedSequenceDataLayer, project: string) {
  return {
    source: { project: layer.project ?? project, id: layer.document.id, revision: layer.revision },
    unit: layer.document.unit,
    valueColumns: layer.document.valueColumns,
    mapping: layer.document.mapping,
    aggregation: layer.document.aggregation,
    unresolvedPolicy: layer.document.unresolvedPolicy,
    ...(layer.document.source.origin ? { origin: layer.document.source.origin } : {}),
  };
}

export function createSequenceDataLayersTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Inspect an existing saved sequence and attach a user CSV dataset as a durable scientific data layer. For an indexed prepared reference, obtain its exact sequenceDataLayerTargets entry with track_views references; indexed mapping currently supports contigs up to 6000000 bases. Start with target to obtain exact sequence and annotation fingerprints. Create requires an explicit position convention or stable annotation identifier join, numeric value columns, units and unmatched-row policy. For named color palettes, use presentation.style.colorScale.paletteId instead of colors; paletteId resolves the central scientific palette. Use colors only for explicit custom RGB scales. It retains the CSV snapshot, mapping report and presentation in the project. Missing values remain distinct from zero. Reuse a published dataset on another sequence with csv kind layer and its exact source project, id and revision; keep its units and choose from its measurement columns. Both projects must be available to this caller. It does not edit the sequence. Reuse identical requestId and inputs after an uncertain response; inspect/list before starting a different creation. Returns mapped/unmatched counts and a saved layer path. Existing views discover matching layers; view attachment or drawing is not guaranteed by file publication.',
    inputSchema: sequenceDataLayersToolSchema,
    execute: async (input: SequenceDataLayerCommand, options) => {
      if (options.abortSignal?.aborted)
        return toolFailure({
          code: 'CANCELLED',
          error: 'Cancelled before submitting the layer command.',
          retriable: true,
          stateChanged: false,
          partialEffects: [],
        });
      const selected = resolveExplicitProjectRoot(folders, input.project);
      if (!selected)
        return toolFailure({
          code: 'PROJECT_NOT_FOUND',
          error: 'Choose an exact project available to this caller.',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      let command: SequenceDataLayerCommand = { ...input, project: selected.path };
      if (command.operation === 'create' && command.csv.kind === 'layer') {
        const source = resolveExplicitProjectRoot(folders, command.csv.source.project);
        if (!source)
          return toolFailure({
            code: 'PROJECT_NOT_FOUND',
            error: 'Choose an exact source project available to this caller.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        command = {
          ...command,
          csv: { ...command.csv, source: { ...command.csv.source, project: source.path } },
        };
      }
      try {
        const views =
          input.operation === 'create' ? captureSequenceDataLayerViews(input.targetDocumentId) : [];
        const result = await platform().sequenceDataLayers.run(command);
        if (result.status === 'failed')
          return toolFailure({
            code: 'SEQUENCE_DATA_LAYER_FAILED',
            error: result.message,
            retriable: false,
            stateChanged: result.disposition === 'not-published' ? false : 'unknown',
            partialEffects:
              result.disposition === 'not-published'
                ? []
                : [
                    'Reconcile the original requestId before creating another layer. Publication has not been ruled out.',
                  ],
          });
        if (result.status === 'published') {
          const viewAttachments =
            input.operation === 'create'
              ? views.map((view) => ({
                  tabId: view.tabId,
                  status: selectSequenceDataLayerView(view, {
                    project: selected.path,
                    layerId: result.document.id,
                  }),
                }))
              : [];
          window.dispatchEvent(new Event(SEQUENCE_DATA_LAYERS_CHANGED));
          return toolSuccess({
            status: result.status,
            data: {
              id: result.document.id,
              path: result.path,
              revision: result.revision,
              ...reusableSource(result, selected.path),
              target: result.document.target,
              label: result.document.label,
              counts: result.document.report.counts,
              availability: result.availability,
              alreadyPublished: result.alreadyPublished,
              warning: result.warning,
              presentation: result.document.presentation,
              viewAttachments,
            },
          });
        }
        if (result.status === 'needs-input')
          return toolSuccess({
            status: result.status,
            data: { target: result.target, report: result.prepared.report, published: false },
          });
        if (result.status === 'listed')
          return toolSuccess({
            status: result.status,
            data: {
              errors: result.errors,
              layers: result.layers.map((layer) => ({
                id: layer.document.id,
                label: layer.document.label,
                path: layer.path,
                revision: layer.revision,
                ...reusableSource(layer, selected.path),
                availability: layer.availability,
                counts: layer.document.report.counts,
                target: layer.document.target,
              })),
            },
          });
        return toolSuccess({
          status: result.status,
          data: { target: result.target, annotationIdentifiers: result.annotationIdentifiers },
        });
      } catch (error) {
        return toolFailure({
          code: 'SEQUENCE_DATA_LAYER_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: input.operation === 'create' ? 'unknown' : false,
          partialEffects:
            input.operation === 'create'
              ? [
                  'The native command may have published. Inspect or retry the unchanged requestId and inputs; a lost response does not undo a saved layer.',
                ]
              : [],
        });
      }
    },
  });
}
