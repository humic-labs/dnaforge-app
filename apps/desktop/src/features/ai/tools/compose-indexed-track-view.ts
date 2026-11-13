   
                                                                            
                                                                      
   
import { z } from 'zod';
import {
  createTrackAdmissionRequestId,
  directTrackAdmissionRequest,
  genomicViewSourceFromAdmission,
  requireGenomicViewBinding,
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type GenomicViewSource,
} from '@waypoint/genome-data';

import { useCanvasStore } from '../../canvas/public/store';
import { admitTrackSource } from '../../sequence/public/track-admission';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
  quantitativeIndexedBigWigDataset,
} from '../../sequence/public/attach-indexed-bigwig';
import {
  applyTrackPresentationPatch,
  useLaneContractStore,
  type Lane,
} from '../../sequence/public/lane-contract-store';
import { indexedGenomeDataTrackFromLane } from '../../sequence/public/ucsc-track-persistence';
import { indexedGenomeBamTrackFromLane } from '../../sequence/public/bam-track-persistence';
import {
  buildExperimentalHybridPileupDataset,
  createSignalReadPileupViewState,
  indexedGenomeSignalReadPileupViewFromLane,
} from '../../sequence/public/experimental-hybrid-pileup';
import { findOpenIndexedTab, resolveIndexedViewTarget } from './indexed-current-view';
import {
  indexedTrackSettingsSchema,
  indexedTrackSnapshot,
  presentationPatchFromAgentSettings,
  type IndexedTrackSettingsInput,
  type IndexedTrackSnapshot,
} from './configure-indexed-track';
import { HEX_COLOR_PATTERN } from '../../../shared/published-schema-patterns';
import {
  resultTool,
  toolFailure,
  toolSuccess,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';

const publicBigWigUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(isCredentialFreeHttpUrl, 'BigWig URL must be a credential-free HTTP(S) URL.');

const signalReadPileupSettingsSchema = z
  .object({
    visible: z.boolean().optional(),
    color: z
      .string()
      .regex(HEX_COLOR_PATTERN)
      .optional(),
    heightPx: z.number().int().min(32).max(2_048).optional(),
    rowHeightPx: z.number().int().min(1).max(128).optional(),
    maxRows: z.number().int().min(1).max(1_000).optional(),
    coverageCutoffDepth: z.number().int().min(1).max(1_000_000_000).optional(),
  })
  .strict();

const signalReadPileupCommon = {
  readsTrackId: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(200).optional(),
  showSourceTracks: z
    .boolean()
    .optional()
    .describe('Defaults to false. The combined lane remains visible either way.'),
  settings: signalReadPileupSettingsSchema.optional(),
};

const signalReadPileupSchema = z.union([
  z
    .object({
      ...signalReadPileupCommon,
      signalTrackId: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      ...signalReadPileupCommon,
      signalUrl: publicBigWigUrl.describe(
        'A new public BigWig to admit and use without a separate tracks entry.'
      ),
    })
    .strict(),
]);

const signalWithReadEvidenceCommon = {
  type: z.literal('signal-with-read-evidence'),
  readsTrackId: z.string().trim().min(1).max(512).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  showSourceTracks: z.boolean().optional(),
};

const signalWithReadEvidenceSchema = z
  .union([
    z
      .object({
        ...signalWithReadEvidenceCommon,
        signalTrackId: z.string().trim().min(1).max(512),
      })
      .strict(),
    z
      .object({
        ...signalWithReadEvidenceCommon,
        signalUrl: publicBigWigUrl,
      })
      .strict(),
  ])
  .refine((view) => view.readsTrackId !== undefined || view.showSourceTracks !== false, {
    message: 'A signal-only view cannot hide its only source track.',
  });

export const composeIndexedTrackViewSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    preserveCurrentTracks: z
      .boolean()
      .optional()
      .describe('Defaults to true. Existing tracks are copied unless explicitly removed.'),
    removeTrackIds: z
      .array(z.string().trim().min(1).max(512))
      .max(256)
      .optional()
      .describe('Existing data-track ids to omit from the new view.'),
    tracks: z
      .array(
        z
          .object({
            kind: z.literal('bigwig-url'),
            url: publicBigWigUrl,
            settings: indexedTrackSettingsSchema.optional(),
          })
          .strict()
      )
      .max(64)
      .optional()
      .describe('New public BigWig tracks to admit before opening the composed view.'),
    signalReadPileups: z
      .array(signalReadPileupSchema)
      .max(64)
      .optional()
      .describe(
        'Combined BigWig-to-BAM/CRAM handoff lanes. Reference an existing BigWig by track id, or provide a public BigWig URL that is admitted in the same transaction.'
      ),
    views: z
      .array(signalWithReadEvidenceSchema)
      .max(64)
      .optional()
      .describe(
        'Signal-first views. A quantitative BigWig is required; readsTrackId is optional. Without reads, the signal remains a normal visible track. With admitted reads, it becomes the combined handoff lane.'
      ),
    viewport: z
      .object({
        chrom: z.string().trim().min(1).max(512),
        start0: z.number().int().nonnegative(),
        end0: z.number().int().positive(),
      })
      .strict()
      .refine((range) => range.end0 > range.start0, 'end0 must be greater than start0.')
      .optional(),
  })
  .strict();

export type ComposeIndexedTrackViewInput = z.infer<typeof composeIndexedTrackViewSchema>;

export type ComposeIndexedTrackViewResult =
  | {
      ok: true;
      tabId: string;
      assemblyId: string;
      name: string;
      unsaved: true;
      tracks: IndexedTrackSnapshot[];
    }
  | (ToolFailure & {
      code:
        | 'CANCELLED'
        | 'NO_INDEXED_VIEW'
        | 'NO_ASSEMBLY_REFERENCES'
        | 'INVALID_COMPOSITION'
        | 'ADMISSION_FAILED'
        | 'VIEW_NOT_CREATED';
    });

type AdmitTrackSource = typeof admitTrackSource;

export function createComposeIndexedTrackViewTool(dependencies?: { admit?: AdmitTrackSource }) {
  const admit = dependencies?.admit ?? admitTrackSource;
  return resultTool({
    description:
      'Compose a separate unsaved Track View from the currently open indexed reference. ' +
      'Existing tracks are preserved by default and can be explicitly removed by track id. ' +
      'Use views to bind a BigWig signal with optional BAM/CRAM read evidence, or signalReadPileups for the older mandatory-read input. ' +
      'New public BigWig URLs and view bindings are preflighted before the new tab is created, so a failed source leaves the current view unchanged. Returns the complete resulting track state and each combined lane’s source relationship.',
    inputSchema: composeIndexedTrackViewSchema as z.ZodTypeAny,
    execute: async (
      input: ComposeIndexedTrackViewInput,
      options
    ): Promise<ComposeIndexedTrackViewResult> => {
      if (options?.abortSignal?.aborted) return cancelled();
      const found = findOpenIndexedTab(useCanvasStore.getState());
      if (!found) {
        return composeFailure('NO_INDEXED_VIEW', 'No indexed genome tab is open.');
      }
      const indexedGenome = found.tab.indexedGenome;
      const assemblyId = assemblyIdFromIndexedGenome(indexedGenome);
      const assemblyReferences = assemblyReferencesFromIndexedGenome(indexedGenome);
      if (assemblyReferences.length === 0) {
        return composeFailure(
          'NO_ASSEMBLY_REFERENCES',
          'The open indexed genome has no chromosome identity to verify tracks.'
        );
      }
      let viewport = input.viewport;
      if (viewport) {
        const target = resolveIndexedViewTarget(found.tab, viewport);
        if ('ok' in target) {
          return composeFailure('INVALID_COMPOSITION', target.message);
        }
        viewport = { ...viewport, chrom: target.chrom };
      }
      const laneStore = useLaneContractStore.getState();
      const currentLanes = laneStore.lanesForOwner(found.tab.id);
      const currentById = new Map(currentLanes.map((lane) => [lane.dataset.trackId, lane]));
      const removeTrackIds = new Set(input.removeTrackIds ?? []);
      const unknownRemovals = [...removeTrackIds].filter((trackId) => !currentById.has(trackId));
      if (unknownRemovals.length > 0) {
        return composeFailure(
          'INVALID_COMPOSITION',
          `Cannot remove unknown track ids: ${unknownRemovals.join(', ')}.`
        );
      }
      const preserveCurrentTracks = input.preserveCurrentTracks ?? true;
      let baseLanes: Lane[] = preserveCurrentTracks
        ? currentLanes.filter((lane) => !removeTrackIds.has(lane.dataset.trackId)).map(cloneLane)
        : [];
      baseLanes = normalizeSignalReadPileupLanes(baseLanes);
      const signalViews = [...(input.signalReadPileups ?? []), ...(input.views ?? [])];
      for (const view of signalViews) {
        if (view.readsTrackId) {
          const readsLane = baseLanes.find((lane) => lane.dataset.trackId === view.readsTrackId);
          if (readsLane?.dataset.kind !== 'pileup' || !readsLane.dataset.source) {
            return composeFailure(
              'INVALID_COMPOSITION',
              `Signal-to-reads composition requires existing BAM/CRAM track ${view.readsTrackId}.`
            );
          }
          try {
            const binding = requireGenomicViewBinding('regional-reads', {
              reads: genomicViewReadsSource(readsLane),
            });
            if (binding.assemblyId !== assemblyId) {
              throw new Error('The read source does not match the open reference assembly.');
            }
          } catch (error) {
            return composeFailure(
              'INVALID_COMPOSITION',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
        if ('signalTrackId' in view) {
          const signalLane = baseLanes.find((lane) => lane.dataset.trackId === view.signalTrackId);
          if (!isComposableBigWigLane(signalLane)) {
            return composeFailure(
              'INVALID_COMPOSITION',
              `Signal-to-reads composition requires existing quantitative BigWig track ${view.signalTrackId}.`
            );
          }
          try {
            const binding = requireGenomicViewBinding('quantitative-signal', {
              signal: genomicViewSourceFromAdmission(signalLane.dataset.trackId, signalLane.source),
            });
            if (binding.assemblyId !== assemblyId) {
              throw new Error('The signal source does not match the open reference assembly.');
            }
          } catch (error) {
            return composeFailure(
              'INVALID_COMPOSITION',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      const explicitlyRequested = input.tracks ?? [];
      const explicitUrls = new Set<string>();
      for (const request of explicitlyRequested) {
        if (explicitUrls.has(request.url)) {
          return composeFailure(
            'INVALID_COMPOSITION',
            'The composition requests the same BigWig URL more than once.'
          );
        }
        explicitUrls.add(request.url);
      }
      const requested = [...explicitlyRequested];
      const requestedUrls = new Set(explicitUrls);
      for (const view of signalViews) {
        if (!('signalUrl' in view) || requestedUrls.has(view.signalUrl)) continue;
        requested.push({ kind: 'bigwig-url' as const, url: view.signalUrl });
        requestedUrls.add(view.signalUrl);
      }
      const admissionRequests = requested.map((entry) =>
        directTrackAdmissionRequest({
          assemblyId,
          input: { kind: 'url', url: entry.url },
          formatId: 'bigwig',
          ingress: 'automation',
          ...(entry.settings?.label ? { label: entry.settings.label } : {}),
        })
      );
      const requestedIds = admissionRequests.map(createTrackAdmissionRequestId);
      const requestedTrackIdByUrl = new Map(
        requested.map((entry, index) => [entry.url, requestedIds[index]] as const)
      );

      let admitted: ReadonlyArray<AdmittedTrackSource | null>;
      try {
        const admittedByIndex = new Array<AdmittedTrackSource | null>(requested.length).fill(null);
        const pendingByOrigin = new Map<string, number[]>();
        for (let index = 0; index < requested.length; index += 1) {
          const existing = baseLanes.find(
            (lane) => lane.dataset.trackId === requestedIds[index] && lane.source
          );
          if (existing?.source?.scientificKind === 'quantitative') continue;
          const origin = new URL(requested[index].url).origin;
          const pending = pendingByOrigin.get(origin) ?? [];
          pending.push(index);
          pendingByOrigin.set(origin, pending);
        }
        await Promise.all(
          [...pendingByOrigin.values()].map(async (indices) => {
            for (const index of indices) {
              if (options?.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
              const source = await admit({
                request: admissionRequests[index],
                assemblyId,
                assemblyReferences,
                signal: options?.abortSignal,
              });
              if (
                source.formatId !== 'bigwig' ||
                source.readerKind !== 'bbi' ||
                source.scientificKind !== 'quantitative'
              ) {
                throw new Error(
                  `The admitted ${source.formatId} ${source.scientificKind} source has no composition adapter.`
                );
              }
              admittedByIndex[index] = source;
            }
          })
        );
        admitted = admittedByIndex;
      } catch (error) {
        return composeFailure(
          options?.abortSignal?.aborted ? 'CANCELLED' : 'ADMISSION_FAILED',
          options?.abortSignal?.aborted
            ? 'Track View composition was cancelled.'
            : error instanceof Error
              ? error.message
              : 'A BigWig source failed admission.',
          !options?.abortSignal?.aborted
        );
      }
      if (options?.abortSignal?.aborted) return cancelled();

      let nextLanes = [...baseLanes];
      try {
        for (let index = 0; index < requested.length; index += 1) {
          const request = requested[index];
          const trackId = requestedIds[index];
          const existingIndex = nextLanes.findIndex((lane) => lane.dataset.trackId === trackId);
          let lane: Lane;
          if (existingIndex >= 0) {
            lane = nextLanes[existingIndex];
          } else {
            const source = admitted[index];
            if (!source) throw new Error(`BigWig ${request.url} has no admitted source.`);
            const label = trackAdmissionRequestLabel(admissionRequests[index]);
            lane = {
              assemblyId,
              order: nextLanes.length,
              visible: true,
              dataset: quantitativeIndexedBigWigDataset({ trackId, label, source }),
              source,
            };
          }
          lane = applyAgentSettingsToLane(lane, request.settings);
          if (existingIndex >= 0) nextLanes[existingIndex] = lane;
          else nextLanes.push(lane);
        }

        const requestedSourcePairs = new Set<string>();
        const standaloneSignalTrackIds = new Set<string>();
        for (const view of signalViews) {
          const signalTrackId =
            'signalTrackId' in view
              ? view.signalTrackId
              : requestedTrackIdByUrl.get(view.signalUrl);
          if (!signalTrackId) {
            throw new Error(
              `BigWig ${'signalUrl' in view ? view.signalUrl : view.signalTrackId} has no admitted track identity.`
            );
          }
          const sourcePair = JSON.stringify([view.readsTrackId ?? null, signalTrackId]);
          if (requestedSourcePairs.has(sourcePair)) {
            throw new Error('The composition requests the same view source binding twice.');
          }
          requestedSourcePairs.add(sourcePair);
          const signalLane = nextLanes.find((lane) => lane.dataset.trackId === signalTrackId);
          if (!isComposableBigWigLane(signalLane)) {
            throw new Error(
              `Signal-to-reads composition requires quantitative BigWig track ${signalTrackId}.`
            );
          }
          const readsLane = view.readsTrackId
            ? nextLanes.find((lane) => lane.dataset.trackId === view.readsTrackId)
            : undefined;
          if (
            view.readsTrackId &&
            (readsLane?.dataset.kind !== 'pileup' || !readsLane.dataset.source)
          ) {
            throw new Error(
              `Signal-to-reads composition requires BAM/CRAM track ${view.readsTrackId}.`
            );
          }
          requireComposableSignalViewBinding(signalLane, readsLane, assemblyId);
          if (!view.readsTrackId) {
            standaloneSignalTrackIds.add(signalTrackId);
            const signalIndex = nextLanes.findIndex(
              (lane) => lane.dataset.trackId === signalTrackId
            );
            nextLanes[signalIndex] = {
              ...signalLane,
              visible: true,
              ...(view.label ? { dataset: { ...signalLane.dataset, label: view.label } } : {}),
            };
            continue;
          }
          if (readsLane?.dataset.kind !== 'pileup' || !readsLane.dataset.source) {
            throw new Error(
              `Signal-to-reads composition requires BAM/CRAM track ${view.readsTrackId}.`
            );
          }
          const existingIndex = nextLanes.findIndex(
            (lane) =>
              lane.dataset.experimentalHybrid?.alignmentTrackId === view.readsTrackId &&
              lane.dataset.experimentalHybrid?.quantitativeTrackId === signalTrackId
          );
          let combinedLane: Lane;
          if (existingIndex >= 0) {
            combinedLane = nextLanes[existingIndex];
          } else {
            const state = createSignalReadPileupViewState({
              assemblyId,
              alignment: readsLane.dataset,
              signal: signalLane.dataset,
              label: view.label,
              order: nextLanes.length,
            });
            combinedLane = {
              assemblyId,
              order: nextLanes.length,
              visible: true,
              dataset: buildExperimentalHybridPileupDataset({
                alignment: readsLane.dataset,
                signal: signalLane.dataset,
                view: state,
              }),
            };
          }
          const legacySettings = 'settings' in view ? view.settings : undefined;
          const combinedSettings: IndexedTrackSettingsInput | undefined =
            legacySettings || view.label
              ? { ...legacySettings, ...(view.label ? { label: view.label } : {}) }
              : undefined;
          combinedLane = applyAgentSettingsToLane(combinedLane, combinedSettings);
          if (existingIndex >= 0) nextLanes[existingIndex] = combinedLane;
          else nextLanes.push(combinedLane);

          const showSources = view.showSourceTracks ?? false;
          nextLanes = nextLanes.map((lane) =>
            lane.dataset.trackId === view.readsTrackId || lane.dataset.trackId === signalTrackId
              ? { ...lane, visible: showSources }
              : lane
          );
        }
        if (standaloneSignalTrackIds.size > 0) {
          nextLanes = nextLanes.map((lane) =>
            standaloneSignalTrackIds.has(lane.dataset.trackId) ? { ...lane, visible: true } : lane
          );
        }
      } catch (error) {
        return composeFailure(
          'INVALID_COMPOSITION',
          error instanceof Error ? error.message : String(error)
        );
      }
      nextLanes = nextLanes.map((lane, order) => ({ ...lane, order }));

      const dataTracks = nextLanes.flatMap((lane) => {
        const state = indexedGenomeDataTrackFromLane(lane);
        return state ? [state] : [];
      });
      const bamTracks = nextLanes.flatMap((lane) => {
        const state = indexedGenomeBamTrackFromLane(lane);
        return state ? [state] : [];
      });
      const signalReadPileupViews = nextLanes.flatMap((lane) => {
        const state = indexedGenomeSignalReadPileupViewFromLane(lane);
        return state ? [state] : [];
      });
      const preservedDataTrackIds = new Set(dataTracks.map((track) => track.trackId));
      const preservedBamTrackIds = new Set(bamTracks.map((track) => track.trackId));
      if (preserveCurrentTracks) {
        for (const track of indexedGenome.dataTracks ?? []) {
          if (!removeTrackIds.has(track.trackId) && !preservedDataTrackIds.has(track.trackId)) {
            dataTracks.push(track);
          }
        }
        for (const track of indexedGenome.bamTracks ?? []) {
          if (!removeTrackIds.has(track.trackId) && !preservedBamTrackIds.has(track.trackId)) {
            bamTracks.push(track);
          }
        }
      }

      let createdTabId: string | undefined;
      try {
        const compositionId = `track-view-draft-${crypto.randomUUID()}`;
        const { id: _oldTabId, trackView: _savedView, ...currentTab } = found.tab;
        const tabId = useCanvasStore.getState().openTab(found.panelId, {
          ...currentTab,
          entityId: compositionId,
          sequenceDocument: { kind: 'indexed-sequence', documentId: compositionId },
          label: input.name,
          isDirty: true,
          indexedGenome: {
            ...indexedGenome,
            dataTracks,
            bamTracks,
            signalReadPileupViews,
            ucscTracks: undefined,
            ...(viewport
              ? {
                  scope: {
                    kind: 'locus' as const,
                    chrom: viewport.chrom,
                    start: viewport.start0,
                    end: viewport.end0,
                  },
                }
              : {}),
          },
          viewState: {
            ...found.tab.viewState,
            ...(viewport
              ? {
                  indexedViewport: { start0: viewport.start0, end0: viewport.end0 },
                  indexedViewportCommand: {
                    id: Date.now(),
                    chrom: viewport.chrom,
                    start0: viewport.start0,
                    end0: viewport.end0,
                  },
                }
              : {}),
          },
        });
        if (!tabId) {
          return composeFailure('VIEW_NOT_CREATED', 'The composed Track View could not be opened.');
        }
        createdTabId = tabId;
        laneStore.replaceOwnerLanes(tabId, nextLanes);
        return toolSuccess({
          tabId,
          assemblyId,
          name: input.name,
          unsaved: true as const,
          tracks: laneStore.lanesForOwner(tabId).map(indexedTrackSnapshot),
        });
      } catch (error) {
        return {
          ...composeFailure(
            'VIEW_NOT_CREATED',
            error instanceof Error ? error.message : String(error)
          ),
          stateChanged: createdTabId ? true : 'unknown',
          partialEffects: createdTabId ? [`track-view-tab:${createdTabId}`] : [],
        };
      }
    },
  });
}

   
                                                                            
                                                                               
                                                                    
   
export async function composeIndexedTrackView(
  input: unknown,
  dependencies?: { admit?: AdmitTrackSource; abortSignal?: AbortSignal }
): Promise<ComposeIndexedTrackViewResult> {
  const parsed = composeIndexedTrackViewSchema.safeParse(input);
  if (!parsed.success) {
    return composeFailure(
      'INVALID_COMPOSITION',
      parsed.error.issues[0]?.message ?? 'Invalid Track View composition.'
    );
  }
  const tool = createComposeIndexedTrackViewTool({ admit: dependencies?.admit });
  if (!tool.execute) {
    return composeFailure(
      'VIEW_NOT_CREATED',
      'The Track View composition executor is unavailable.'
    );
  }
  return (await tool.execute(parsed.data, {
    toolCallId: 'programmatic-compose-indexed-track-view',
    messages: [],
    abortSignal: dependencies?.abortSignal,
  })) as ComposeIndexedTrackViewResult;
}

function applyAgentSettingsToLane(
  lane: Lane,
  settings: IndexedTrackSettingsInput | undefined
): Lane {
  if (!settings) return lane;
  const patch = presentationPatchFromAgentSettings(lane, settings);
  return {
    ...lane,
    visible: settings.visible ?? lane.visible,
    dataset: applyTrackPresentationPatch(lane.dataset, patch),
  };
}

function cloneLane(lane: Lane): Lane {
  return {
    ...lane,
    dataset: {
      ...lane.dataset,
      ...(lane.dataset.quantitativePresentation
        ? {
            quantitativePresentation: {
              ...lane.dataset.quantitativePresentation,
              scale: { ...lane.dataset.quantitativePresentation.scale },
            },
          }
        : {}),
      ...(lane.dataset.source ? { source: { ...lane.dataset.source } } : {}),
    },
    ...(lane.source ? { source: { ...lane.source } } : {}),
  };
}

function isComposableBigWigLane(
  lane: Lane | undefined
): lane is Lane & { readonly source: AdmittedTrackSource } {
  return Boolean(
    lane &&
    lane.dataset.kind !== 'pileup' &&
    lane.dataset.trackType === 'quantitative' &&
    lane.source?.formatId === 'bigwig' &&
    lane.source.scientificKind === 'quantitative' &&
    lane.source.referenceReceipt.status === 'compatible'
  );
}

function requireComposableSignalViewBinding(
  signalLane: Lane & { readonly source: AdmittedTrackSource },
  readsLane: Lane | undefined,
  assemblyId: string
): void {
  const binding = requireGenomicViewBinding('signal-with-read-evidence', {
    signal: genomicViewSourceFromAdmission(signalLane.dataset.trackId, signalLane.source),
    ...(readsLane ? { reads: genomicViewReadsSource(readsLane) } : {}),
  });
  if (binding.assemblyId !== assemblyId) {
    throw new Error('The view sources do not match the open reference assembly.');
  }
}

function genomicViewReadsSource(lane: Lane): GenomicViewSource {
  if (lane.dataset.kind !== 'pileup' || !lane.dataset.source) {
    throw new Error(`Track ${lane.dataset.trackId} has no admitted regional reads.`);
  }
  const source = lane.dataset.source;
  const admitted = lane.source
    ? genomicViewSourceFromAdmission(lane.dataset.trackId, lane.source)
    : undefined;
  return {
    id: lane.dataset.trackId,
    assemblyId: admitted?.assemblyId ?? lane.assemblyId,
    scientificKind: admitted?.scientificKind ?? 'reads',
    formatId:
      admitted?.formatId ??
      source.htsget?.format.toLowerCase() ??
      (source.bamPath.split(/[?#]/u, 1)[0]?.toLowerCase().endsWith('.cram') ? 'cram' : 'bam'),
    regionalAccess: source.admissionError
      ? 'none'
      : (admitted?.regionalAccess ??
        (source.htsget ? 'service' : source.generation?.index ? 'companion-index' : 'none')),
  };
}

function normalizeSignalReadPileupLanes(lanes: ReadonlyArray<Lane>): Lane[] {
  const sourceTrackIds = new Set(lanes.map((lane) => lane.dataset.trackId));
  const sourcePairs = new Set<string>();
  return lanes.filter((lane) => {
    const hybrid = lane.dataset.experimentalHybrid;
    if (!hybrid) return true;
    if (
      !sourceTrackIds.has(hybrid.alignmentTrackId) ||
      !sourceTrackIds.has(hybrid.quantitativeTrackId)
    ) {
      return false;
    }
    const pair = `${hybrid.alignmentTrackId}\u0000${hybrid.quantitativeTrackId}`;
    if (sourcePairs.has(pair)) return false;
    sourcePairs.add(pair);
    return true;
  });
}

function isCredentialFreeHttpUrl(value: string): boolean {
  if (value.includes(String.fromCharCode(0)) || /[\r\n]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function cancelled(): ComposeIndexedTrackViewResult {
  return composeFailure('CANCELLED', 'Track View composition was cancelled.');
}

function composeFailure(
  code: Extract<ComposeIndexedTrackViewResult, { ok: false }>['code'],
  error: string,
  retriable = false
): Extract<ComposeIndexedTrackViewResult, { ok: false }> {
  return {
    ...toolFailure({ code, error, retriable, stateChanged: false, partialEffects: [] }),
    code,
  };
}
