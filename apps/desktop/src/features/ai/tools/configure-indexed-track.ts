                                                                                         
import { z } from 'zod';
import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
  QUANTITATIVE_COLOR_PALETTE_IDS,
  normalizeQuantitativeTrackPresentation,
  type QuantitativeTrackPresentationV1,
} from '@waypoint/genome-data';

import { useCanvasStore } from '../../canvas/public/store';
import {
  applyTrackPresentationPatch,
  useLaneContractStore,
  type Lane,
  type TrackPresentationPatch,
} from '../../sequence/public/lane-contract-store';
import { findOpenIndexedTab } from './indexed-current-view';
import { HEX_COLOR_PATTERN } from '../../../shared/published-schema-patterns';
import {
  resultTool,
  toolFailure,
  toolSuccess,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';

const quantitativeSettingsSchema = z
  .object({
    graph: z.enum(['bar', 'band', 'points']).optional().describe('Native genomic bars, heatmap band, or value points.'),
    palette: z.enum(QUANTITATIVE_COLOR_PALETTE_IDS).optional().describe('Shared scientific color palette used by heatmap bands.'),
    mode: z
      .enum(['robust-global', 'full-global', 'visible-window', 'fixed'])
      .optional()
      .describe('Stable whole-track, exact whole-track, visible-window, or fixed Y range.'),
    transform: z
      .enum(['linear', 'log1p'])
      .optional()
      .describe('Linear, or log1p for nonnegative signal only.'),
    smoothingSigmaBins: z
      .number()
      .finite()
      .min(0)
      .max(MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS)
      .optional()
      .describe(
        'Gaussian smoothing standard deviation in adjacent source bins. Zero disables smoothing; missing regions remain hard boundaries.'
      ),
    min: z.number().finite().optional().describe('Fixed range minimum; valid only in fixed mode.'),
    max: z.number().finite().optional().describe('Fixed range maximum; valid only in fixed mode.'),
    showRange: z.boolean().optional().describe('Show the selected scale values in track settings.'),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (settings.min !== undefined || settings.max !== undefined) {
      if (settings.mode !== undefined && settings.mode !== 'fixed') {
        ctx.addIssue({ code: 'custom', message: 'min and max are valid only for fixed mode.' });
      }
    }
    if (settings.min !== undefined && settings.max !== undefined && settings.min >= settings.max) {
      ctx.addIssue({ code: 'custom', message: 'Fixed minimum must be below fixed maximum.' });
    }
  });

export const indexedTrackSettingsSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    visible: z.boolean().optional(),
    color: z
      .string()
      .regex(HEX_COLOR_PATTERN)
      .optional()
      .describe('Display color in #rrggbb form.'),
    heightPx: z.number().int().min(32).max(2048).optional(),
    rowHeightPx: z.number().int().min(1).max(128).optional(),
    maxRows: z.number().int().min(1).max(1000).optional(),
    coverageCutoffDepth: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .optional()
      .describe('BAM/CRAM histogram cutoff. Zero selects source-wide p99 automatic scaling.'),
    quantitative: quantitativeSettingsSchema.optional(),
  })
  .strict()
  .refine((settings) => Object.values(settings).some((value) => value !== undefined), {
    message: 'At least one track setting is required.',
  });

export const configureIndexedTrackSchema = z
  .object({
    trackId: z.string().trim().min(1).max(512),
    settings: indexedTrackSettingsSchema,
  })
  .strict();

export type IndexedTrackSettingsInput = z.infer<typeof indexedTrackSettingsSchema>;
export type ConfigureIndexedTrackInput = z.infer<typeof configureIndexedTrackSchema>;

export interface IndexedTrackSnapshot {
  trackId: string;
  trackType: string;
  family: 'quantitative' | 'reads' | 'annotation';
  order: number;
  visible: boolean;
  label: string;
  color: string;
  heightPx: number;
  rowHeightPx?: number;
  maxRows?: number;
  source?: {
    uri?: string;
    formatId?: string;
    fingerprint?: string;
    bamPath?: string;
    indexPath?: string;
    referencePath?: string;
  };
  coverageCutoffDepth?: number;
  quantitative?: QuantitativeTrackPresentationV1 & {
    sourceSummary?: Lane['dataset']['quantitativeSourceSummary'];
  };
  composition?: {
    kind: 'signal-read-pileup';
    readsTrackId: string;
    signalTrackId: string;
  };
}

export type ConfigureIndexedTrackResult =
  | { ok: true; tabId: string; track: IndexedTrackSnapshot }
  | (ToolFailure & {
      code: 'CANCELLED' | 'NO_INDEXED_VIEW' | 'TRACK_NOT_FOUND' | 'INVALID_SETTINGS';
    });

export function createConfigureIndexedTrackTool() {
  return resultTool({
    description:
      'Change one track in the open indexed genome view using the same validated settings as the track gutter. ' +
      'Common settings include name, visibility, color, and height. Quantitative signal tracks additionally support stable/exact/visible/fixed range, linear/log1p scaling, and a numeric Gaussian smoothing strength. BAM/CRAM tracks additionally support read-row height, maximum rows, and automatic or fixed coverage cutoff. Returns the complete resulting track state.',
    inputSchema: configureIndexedTrackSchema as z.ZodTypeAny,
    execute: async (
      input: ConfigureIndexedTrackInput,
      options
    ): Promise<ConfigureIndexedTrackResult> => {
      if (options?.abortSignal?.aborted) {
        return configureFailure('CANCELLED', 'Track configuration was cancelled.');
      }
      const found = findOpenIndexedTab(useCanvasStore.getState());
      if (!found) {
        return configureFailure('NO_INDEXED_VIEW', 'No indexed genome tab is open.');
      }
      const store = useLaneContractStore.getState();
      const lane = store
        .lanesForOwner(found.tab.id)
        .find((candidate) => candidate.dataset.trackId === input.trackId);
      if (!lane) {
        return configureFailure(
          'TRACK_NOT_FOUND',
          `Track ${input.trackId} is not present in the open indexed view.`
        );
      }
      let patch: TrackPresentationPatch;
      try {
        patch = presentationPatchFromAgentSettings(lane, input.settings);
                                                                                     
        applyTrackPresentationPatch(lane.dataset, patch);
      } catch (error) {
        return configureFailure(
          'INVALID_SETTINGS',
          error instanceof Error ? error.message : String(error)
        );
      }
      const partialEffects: string[] = [];
      let mutationAttempted = false;
      try {
        const hasPresentationPatch = Object.values(patch).some((value) => value !== undefined);
        if (hasPresentationPatch) {
          mutationAttempted = true;
          const result = store.updateLanePresentation(found.tab.id, input.trackId, patch);
          if (result.status !== 'updated') {
            return configureFailure('INVALID_SETTINGS', result.message);
          }
          partialEffects.push(`track-presentation:${input.trackId}`);
        }
        if (input.settings.visible !== undefined) {
          mutationAttempted = true;
          store.setLaneVisible(found.tab.id, input.trackId, input.settings.visible);
          partialEffects.push(`track-visibility:${input.trackId}`);
        }
        const updated = store
          .lanesForOwner(found.tab.id)
          .find((candidate) => candidate.dataset.trackId === input.trackId);
        if (!updated) {
          return configureFailure(
            'TRACK_NOT_FOUND',
            `Track ${input.trackId} disappeared before its settings were read back.`,
            partialEffects.length > 0,
            partialEffects
          );
        }
        return toolSuccess({ tabId: found.tab.id, track: indexedTrackSnapshot(updated) });
      } catch (error) {
        return configureFailure(
          'INVALID_SETTINGS',
          error instanceof Error ? error.message : String(error),
          mutationAttempted ? 'unknown' : false,
          partialEffects
        );
      }
    },
  });
}

function configureFailure(
  code: Extract<ConfigureIndexedTrackResult, { ok: false }>['code'],
  error: string,
  stateChanged: boolean | 'unknown' = false,
  partialEffects: readonly string[] = []
): ConfigureIndexedTrackResult {
  return { ...toolFailure({ code, error, retriable: false, stateChanged, partialEffects }), code };
}

export function presentationPatchFromAgentSettings(
  lane: Lane,
  settings: IndexedTrackSettingsInput
): TrackPresentationPatch {
  if (
    (settings.rowHeightPx !== undefined || settings.maxRows !== undefined) &&
    lane.dataset.kind !== 'pileup'
  ) {
    throw new Error('Read row height and maximum rows are only valid for BAM/CRAM tracks.');
  }
  const patch: TrackPresentationPatch = {
    ...(settings.label !== undefined ? { label: settings.label } : {}),
    ...(settings.color !== undefined
      ? { color: Number.parseInt(settings.color.slice(1), 16) }
      : {}),
    ...(settings.heightPx !== undefined ? { heightPx: settings.heightPx } : {}),
    ...(settings.rowHeightPx !== undefined ? { rowHeightPx: settings.rowHeightPx } : {}),
    ...(settings.maxRows !== undefined ? { maxRows: settings.maxRows } : {}),
    ...(settings.coverageCutoffDepth !== undefined
      ? { coverageCutoffDepth: settings.coverageCutoffDepth }
      : {}),
  };
  if (settings.quantitative) {
    if (
      settings.quantitative.smoothingSigmaBins !== undefined &&
      lane.dataset.trackType !== 'quantitative'
    ) {
      throw new Error('Signal smoothing is only valid for quantitative signal tracks.');
    }
    const current = normalizeQuantitativeTrackPresentation(
      lane.dataset.quantitativePresentation ?? DEFAULT_QUANTITATIVE_TRACK_PRESENTATION
    );
    const requestedMode = settings.quantitative.mode ?? current.scale.mode;
    const transform = settings.quantitative.transform ?? current.scale.transform;
    let scale: QuantitativeTrackPresentationV1['scale'];
    if (requestedMode === 'fixed') {
      const summary = lane.dataset.quantitativeSourceSummary;
      const currentMin = current.scale.mode === 'fixed' ? current.scale.min : undefined;
      const currentMax = current.scale.mode === 'fixed' ? current.scale.max : undefined;
      const min = settings.quantitative.min ?? currentMin ?? Math.min(0, summary?.robustMin ?? 0);
      const max = settings.quantitative.max ?? currentMax ?? Math.max(1, summary?.robustMax ?? 1);
      if (max <= min) throw new Error('Fixed quantitative minimum must be below its maximum.');
      scale = { mode: 'fixed', transform, min, max };
    } else {
      if (settings.quantitative.min !== undefined || settings.quantitative.max !== undefined) {
        throw new Error('Fixed min and max require quantitative mode "fixed".');
      }
      scale = { mode: requestedMode, transform };
    }
    return {
      ...patch,
      quantitative: {
        version: 1,
        graph: settings.quantitative.graph ?? current.graph,
        ...((settings.quantitative.palette ?? current.palette) !== undefined
          ? { palette: settings.quantitative.palette ?? current.palette }
          : {}),
        showRange: settings.quantitative.showRange ?? current.showRange,
        smoothingSigmaBins:
          settings.quantitative.smoothingSigmaBins ?? current.smoothingSigmaBins ?? 0,
        scale,
      },
    };
  }
  return patch;
}

export function indexedTrackSnapshot(lane: Lane): IndexedTrackSnapshot {
  const dataset = lane.dataset;
  const isQuantitative =
    dataset.kind !== 'pileup' &&
    (dataset.trackType === 'quantitative' || dataset.trackType === 'peak');
  const quantitative = isQuantitative
    ? {
        ...normalizeQuantitativeTrackPresentation(dataset.quantitativePresentation),
        ...(dataset.quantitativeSourceSummary
          ? { sourceSummary: dataset.quantitativeSourceSummary }
          : {}),
      }
    : undefined;
  return {
    trackId: dataset.trackId,
    trackType: dataset.trackType,
    family: dataset.kind === 'pileup' ? 'reads' : quantitative ? 'quantitative' : 'annotation',
    order: lane.order,
    visible: lane.visible,
    label: dataset.label,
    color: `#${dataset.color.toString(16).padStart(6, '0')}`,
    heightPx: dataset.trackPx,
    ...(dataset.kind === 'pileup' && dataset.laneHeightPx !== undefined
      ? { rowHeightPx: dataset.laneHeightPx }
      : {}),
    ...(dataset.kind === 'pileup' && dataset.maxLanes !== undefined
      ? { maxRows: dataset.maxLanes }
      : {}),
    ...(lane.source
      ? {
          source: {
            uri: lane.source.uri,
            formatId: lane.source.formatId,
            fingerprint: lane.source.fingerprint,
          },
        }
      : dataset.source
        ? {
            source: {
              bamPath: dataset.source.bamPath,
              ...(dataset.source.indexPath ? { indexPath: dataset.source.indexPath } : {}),
              ...(dataset.source.referencePath
                ? { referencePath: dataset.source.referencePath }
                : {}),
            },
          }
        : {}),
    ...(dataset.kind === 'pileup' ? { coverageCutoffDepth: dataset.coverageCutoffDepth ?? 0 } : {}),
    ...(quantitative ? { quantitative } : {}),
    ...(dataset.experimentalHybrid
      ? {
          composition: {
            kind: 'signal-read-pileup' as const,
            readsTrackId: dataset.experimentalHybrid.alignmentTrackId,
            signalTrackId: dataset.experimentalHybrid.quantitativeTrackId,
          },
        }
      : {}),
  };
}
