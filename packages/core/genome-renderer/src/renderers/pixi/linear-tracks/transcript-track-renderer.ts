import { SEQUENCE_LABEL_FONT_FAMILY } from '@waypoint/platform';
import { Container, TextStyle } from 'pixi.js';

import type { TranscriptRecord } from '@waypoint/genome-data';
import type { Feature, SequenceWindow } from '../../../types';
import type { CodonInfo } from '../../../biology/translation';
import { createBaseReader } from '../shared/base-reader';
import {
  codonCarrierRange,
  codonCarrierIntersectsViewport,
  translateCodonCarrier,
} from '../shared/codon-carrier-translation';
import { CodonTrack } from '../tracks/codon-track';

import { RetainedLinearTranscriptLayer } from '../overview/retained-linear-transcript-layer';
import type { ViewerRenderContract } from '../overview/viewer-render-contract';
import { TextPool } from '../shared/text-pool';
import { buildImportedTranscriptGlyphBlocks } from './transcript-track-glyphs';
import { assignAnnotationLanes, type AnnotationLaneAssignment } from './annotation-track-draw-ops';
import { hitTestIntervalTrack } from './interval-hit-test';
import { planBoundedIntervalLabels } from './interval-label-layout';
import { trackMaxRows } from './track-presentation';
import type {
  PixiLinearTrackRenderer,
  TrackHitResult,
  TrackHoverArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';
import type { TrackMeasureContentArgs } from './types';
import { ANNOTATION_BAR_HEIGHT, ANNOTATION_LANE_TOTAL } from '../shared/theme';

const DEFAULT_MAX_LANES = 32;
let transcriptLabelStyleInstance: TextStyle | null = null;
function transcriptLabelStyle(): TextStyle {
  transcriptLabelStyleInstance ??= new TextStyle({
    fontFamily: SEQUENCE_LABEL_FONT_FAMILY,
    fontSize: 7,
    fontWeight: '500',
    lineHeight: 8,
    fill: 0xffffff,
  });
  return transcriptLabelStyleInstance;
}

export interface TranscriptTrackData {
  readonly records: ReadonlyArray<TranscriptRecord>;
}

export interface PixiTranscriptTrackRendererOptions {
  readonly type: string;
  readonly maxLanes?: number;
  readonly maxLabels?: number;
}

interface TranscriptContainerState {
  readonly layer: RetainedLinearTranscriptLayer;
  recordsRef: ReadonlyArray<TranscriptRecord> | null;
  themeMode: 'light' | 'dark' | null;
  maxRows: number;
  revision: number;
  droppedRecordCount: number;
  lanesUsed: number;
  assignment: AnnotationLaneAssignment | null;
  readonly labelPool: TextPool | null;
  labelCount: number;
  features: ReadonlyArray<Feature>;
  readonly codonContainer: Container;
  codonTrack: CodonTrack | null;
  readonly codonCache: Map<Feature, CodonInfo[]>;
  sequenceRef: SequenceWindow | string | undefined;
  cdsDetailProgress: number;
}

export class PixiTranscriptTrackRenderer implements PixiLinearTrackRenderer<TranscriptTrackData> {
  readonly type: string;
  private readonly maxLanes: number;
  private readonly maxLabels: number;
  private readonly states = new WeakMap<Container, TranscriptContainerState>();
  private readonly assignmentCache = new WeakMap<
    ReadonlyArray<TranscriptRecord>,
    Map<number, AnnotationLaneAssignment>
  >();

  constructor(options: PixiTranscriptTrackRendererOptions) {
    this.type = options.type;
    this.maxLanes = options.maxLanes ?? DEFAULT_MAX_LANES;
    this.maxLabels = options.maxLabels ?? 0;
    if (!Number.isSafeInteger(this.maxLabels) || this.maxLabels < 0) {
      throw new Error('PixiTranscriptTrackRenderer maxLabels must be a non-negative integer.');
    }
  }

  mount(_args: TrackMountArgs): Container {
    const layer = new RetainedLinearTranscriptLayer();
    const codonContainer = new Container();
    layer.container.addChild(codonContainer);
    const labelPool =
      this.maxLabels > 0 ? new TextPool(layer.container, transcriptLabelStyle()) : null;
    this.states.set(layer.container, {
      layer,
      recordsRef: null,
      themeMode: null,
      maxRows: this.maxLanes,
      revision: 0,
      droppedRecordCount: 0,
      lanesUsed: 0,
      assignment: null,
      labelPool,
      labelCount: 0,
      features: [],
      codonContainer,
      codonTrack: null,
      codonCache: new Map(),
      sequenceRef: undefined,
      cdsDetailProgress: 0,
    });
    return layer.container;
  }

  measureContentHeight(args: TrackMeasureContentArgs<TranscriptTrackData>): number {
    const records = args.data?.records ?? [];
    if (records.length === 0) return 0;
    const maxRows = trackMaxRows(args.presentation, this.maxLanes);
    return (
      this.assignmentFor(records, args.assembly?.totalLengthBp ?? args.chromosome.length, maxRows)
        .numLanes * ANNOTATION_LANE_TOTAL
    );
  }

  hitTest(args: TrackHoverArgs): TrackHitResult | null {
    const state = this.states.get(args.container);
    if (!state?.recordsRef || !state.assignment) return null;
    return hitTestIntervalTrack({
      pointer: args,
      records: state.recordsRef,
      assignment: state.assignment,
      rowHeightPx: ANNOTATION_LANE_TOTAL,
      nameOf: (record) => record.geneName ?? record.transcriptId,
    });
  }

  paint(args: TrackPaintArgs<TranscriptTrackData>): void {
    const state = this.states.get(args.container);
    if (!state) return;
    const records = args.data?.records ?? [];
    state.codonTrack?.reset();
    if (records.length === 0) {
      state.layer.hide();
      state.labelPool?.reset();
      state.recordsRef = records;
      state.maxRows = trackMaxRows(args.presentation, this.maxLanes);
      state.droppedRecordCount = 0;
      state.lanesUsed = 0;
      state.assignment = null;
      state.labelCount = 0;
      state.features = [];
      state.codonCache.clear();
      state.cdsDetailProgress = 0;
      return;
    }

    const maxRows = trackMaxRows(args.presentation, this.maxLanes);
    if (
      state.recordsRef !== records ||
      state.themeMode !== args.theme.mode ||
      state.maxRows !== maxRows
    ) {
      const assignment = this.assignmentFor(
        records,
        args.assembly?.totalLengthBp ?? args.chromosome.length,
        maxRows
      );
      const built = buildImportedTranscriptGlyphBlocks({
        records,
        chromosomeLength: args.assembly?.totalLengthBp ?? args.chromosome.length,
        maxLanes: maxRows,
        themeMode: args.theme.mode,
        assignment,
      });
      state.recordsRef = records;
      state.themeMode = args.theme.mode;
      state.maxRows = maxRows;
      state.revision += 1;
      state.droppedRecordCount = built.assignment.droppedCount;
      state.lanesUsed = built.assignment.numLanes;
      state.assignment = built.assignment;
      state.features = built.features;
      state.codonCache.clear();
      state.layer.syncData(`${state.revision}:${args.theme.mode}`, built.blocks);
    }

    const originBp = args.viewportBpRange.start;
    const contract: ViewerRenderContract = {
      projectX: (bp) => args.pathMapper.bpLeftX(bp),
      projectY: (offsetPx) => args.containerTopPx + offsetPx,
      pixelsPerBp: args.pathMapper.pixelsPerBp,
      xOriginBp: originBp,
    };
    const detail = args.cdsRendering
      ? Math.max(0, Math.min(1, args.cdsRendering.detailProgress))
      : 0;
    state.cdsDetailProgress = detail;
    state.layer.updateCamera(contract, args.viewportWidthPx, args.viewportHeightPx, detail);
    this.syncCodons(state, args);
    this.syncLabels(state, args, records);
  }

  getDiagnostics(container: Container): object | null {
    const state = this.states.get(container);
    if (!state) return null;
    return {
      recordCount: state.recordsRef?.length ?? 0,
      retainedBlockCount: state.layer.retainedBlockCount,
      droppedRecordCount: state.droppedRecordCount,
      lanesUsed: state.lanesUsed,
      maxLanes: state.maxRows,
      exactReferenceGlyphBuilder: true,
      labelCount: state.labelCount,
      labelLimit: this.maxLabels,
      cdsDetailProgress: state.cdsDetailProgress,
      codonTrack: state.codonTrack?.getDebugSnapshot() ?? null,
    };
  }

  private assignmentFor(
    records: ReadonlyArray<TranscriptRecord>,
    chromosomeLength: number,
    maxRows: number
  ): AnnotationLaneAssignment {
    let byMaxRows = this.assignmentCache.get(records);
    if (!byMaxRows) {
      byMaxRows = new Map();
      this.assignmentCache.set(records, byMaxRows);
    }
    let assignment = byMaxRows.get(maxRows);
    if (!assignment) {
      assignment = assignAnnotationLanes(records, chromosomeLength, maxRows);
      byMaxRows.set(maxRows, assignment);
    }
    return assignment;
  }

  unmount(container: Container): void {
    const state = this.states.get(container);
    if (!state) return;
    this.states.delete(container);
    state.labelPool?.destroy();
    state.codonTrack?.destroy();
    state.layer.destroy();
  }

  private syncLabels(
    state: TranscriptContainerState,
    args: TrackPaintArgs<TranscriptTrackData>,
    records: ReadonlyArray<TranscriptRecord>
  ): void {
    const pool = state.labelPool;
    const assignment = state.assignment;
    if (!pool || !assignment) {
      state.labelCount = 0;
      return;
    }
    pool.reset();
    if (state.cdsDetailProgress >= 1) {
      state.labelCount = 0;
      return;
    }
    const labels = planBoundedIntervalLabels({
      records,
      laneAssignments: assignment.lanes,
      viewportBpRange: args.viewportBpRange,
      viewportWidthPx: args.viewportWidthPx,
      bpToX: (bp) => args.pathMapper.bpLeftX(bp),
      rowHeightPx: ANNOTATION_LANE_TOTAL,
      trackHeightPx: args.layoutEntry.height,
      maxLabels: this.maxLabels,
      estimatedCharacterWidthPx: 6,
      labelForRecord: (record) => record.geneName ?? record.transcriptId,
      strandForRecord: (record) => record.strand,
      isDensityRecord: (record) => Boolean(record.extra?.dnaforgeDensity),
    });
    for (const label of labels) {
      const text = pool.acquire();
      if (text.text !== label.text) text.text = label.text;
      text.position.set(label.x, label.y);
      text.tint = transcriptLabelTint(records[label.recordIndex].color);
      text.alpha = 0.95 * (1 - state.cdsDetailProgress);
    }
    state.labelCount = labels.length;
  }

  private syncCodons(
    state: TranscriptContainerState,
    args: TrackPaintArgs<TranscriptTrackData>
  ): void {
    const context = args.cdsRendering;
    if (!context || !args.pathMapper.sequenceVisible) return;
    const reader = createBaseReader(
      context.genome.sequence,
      context.genome.sequenceWindow,
      context.genome.circular
    );
    if (!reader) return;
    const sequenceRef = context.genome.sequenceWindow ?? context.genome.sequence;
    if (state.sequenceRef !== sequenceRef) {
      state.codonCache.clear();
      state.sequenceRef = sequenceRef;
    }
    for (const feature of state.features) {
      const range = codonCarrierRange(feature);
      if (
        !range ||
        !codonCarrierIntersectsViewport(range, args.viewportBpRange.start, args.viewportBpRange.end)
      )
        continue;
      const center = feature.lane * ANNOTATION_LANE_TOTAL + ANNOTATION_LANE_TOTAL / 2;
      if (center > args.layoutEntry.height) continue;
      let codons = state.codonCache.get(feature);
      if (!codons) {
        codons = translateCodonCarrier(feature, range, reader, context.genome).codons;
        state.codonCache.set(feature, codons);
      }
      if (codons.length === 0) continue;
      state.codonTrack ??= new CodonTrack(state.codonContainer);
      state.codonTrack.renderCodons(
        feature,
        codons,
        args.pathMapper,
        center - args.pathMapper.fwdStrandTop,
        context.genome.length,
        context.state,
        args.pathMapper.sequenceOpacity,
        0,
        ANNOTATION_BAR_HEIGHT / 2
      );
    }
  }
}

function transcriptLabelTint(background = 0x2563eb): number {
  const red = (background >> 16) & 0xff;
  const green = (background >> 8) & 0xff;
  const blue = background & 0xff;
  const luminance = (red * 299 + green * 587 + blue * 114) / 255_000;
  return luminance > 0.58 ? 0x0f172a : 0xffffff;
}
