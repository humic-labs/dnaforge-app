import { Color, Container, Graphics, Text, TextStyle, type Renderer } from 'pixi.js';
import { canvasMiddleTextAnchorY } from '../shared/canvas-middle-text';
import {
  IUPAC_COMPLEMENT,
  complementTable,
  sequenceStrandOverrideAt,
  type NucleicAcid,
  type SequenceStrandOverride,
} from '@waypoint/sequence-utils';
import { SEQUENCE_EDIT_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import { shouldRenderSequence, sequenceOpacity } from '../../../geometry/lod';
import { SEQUENCE_FONT_FAMILY, webglThemeForMode, type WebGLRenderTheme } from '../shared';
import type { LayoutModel } from '../shared/layout-model';
import {
  LINEAR_SEQUENCE_GLYPH_CONTRACT,
  LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
  LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
  configureLinearSequenceGlyph,
  createLinearSequenceGlyph,
  createLinearSequenceGlyphStyles,
  linearSequenceGlyphVerticalMetrics,
} from '../shared/linear-sequence-glyph';
import { sequenceFullViewportPixelsPerBp } from '../shared/sequence-sizing';
import type { LinearSequencePresentation, SequenceWindow } from '../../../types';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import {
  RETAINED_LINEAR_NUCLEOTIDE_OWNER,
  RetainedLinearNucleotideLayer,
  type RetainedLinearNucleotideGpuOwnershipAudit,
} from './retained-linear-nucleotide-layer';

const SIZED_STYLE_CACHE_MAX_ENTRIES = 32;

type BaseReader = (bp: number) => string | undefined;

function sameSequenceWindow(
  left: SequenceWindow | undefined,
  right: SequenceWindow | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.startBp === right.startBp &&
      left.bases === right.bases)
  );
}

function sameSequenceSource(
  leftSequence: string | undefined,
  leftWindow: SequenceWindow | undefined,
  rightSequence: string | undefined,
  rightWindow: SequenceWindow | undefined
): boolean {
  return leftSequence === rightSequence && sameSequenceWindow(leftWindow, rightWindow);
}

export interface IndexedNucleotideGlyphStrandAudit {
  readonly glyphCount: number;
  readonly requiredViewportGlyphCount: number;
  readonly missingViewportBpCount: number;
  readonly hiddenViewportGlyphCount: number;
  readonly sourceMismatchCount: number;
  readonly unknownSubstitutionCount: number;
  readonly fallbackFontGlyphCount: number;
  readonly invalidTextGlyphCount: number;
}

export interface IndexedNucleotideGlyphPresentationAudit {
  readonly contract: 'indexed-nucleotide-glyph-presentation.v1';
  readonly glyphContract: typeof LINEAR_SEQUENCE_GLYPH_CONTRACT;
  readonly expectedFontFamily: typeof SEQUENCE_FONT_FAMILY;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly requiredViewportBaseCount: number;
  readonly sourceCoveredViewportBaseCount: number;
  readonly forward: IndexedNucleotideGlyphStrandAudit;
  readonly reverse: IndexedNucleotideGlyphStrandAudit;
}

function makeBaseReader(
  sequence: string | undefined,
  sequenceWindow: SequenceWindow | undefined,
  wrap: boolean,
  totalLength: number
): BaseReader | null {
  if (sequenceWindow && sequenceWindow.bases.length > 0) {
    const offset = sequenceWindow.startBp;
    const len = sequenceWindow.bases.length;
    return (bp) => {
      const i = bp - offset;
      return i >= 0 && i < len ? sequenceWindow.bases[i] : undefined;
    };
  }
  if (sequence) {
    if (wrap) {
      const len = sequence.length;
      return (bp) => sequence[((bp % len) + len) % len];
    }
    return (bp) => (bp >= 0 && bp < sequence.length ? sequence[bp] : undefined);
  }

  void totalLength;
  return null;
}

const MAX_RENDERED_BASES_PER_STRAND = 3000;
const RECYCLE_POOL_LIMIT_PER_STRAND = 3072;

const LINEAR_SEQUENCE_PREWARM_BATCH_PER_STRAND = 8;
const LINEAR_SEQUENCE_PREWARM_TARGET_PER_STRAND = MAX_RENDERED_BASES_PER_STRAND;
const LINEAR_SEQUENCE_IDLE_PREWARM_PAIRS_PER_SLICE = 16;
const LINEAR_SEQUENCE_IDLE_PREWARM_BUDGET_MS = 2;
const LINEAR_SEQUENCE_IDLE_MIN_REMAINING_MS = 0.75;
const LINEAR_SEQUENCE_IDLE_FORCE_PROGRESS_MS = 50;

const LINEAR_SEQUENCE_CONTENT_PREP_PAIRS_PER_SLICE = 512;
const LINEAR_SEQUENCE_CONTENT_PREP_START_FRACTION = 0.1;
const LINEAR_GEOMETRY_REBASE_VIEWPORTS = 4;

type LinearSequenceIdleDeadline = { timeRemaining: () => number; didTimeout: boolean };
type LinearSequenceIdleGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: (deadline: LinearSequenceIdleDeadline) => void,
    options?: { timeout: number }
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type LinearSequenceGlyphGpuPreparer = (glyphs: readonly Text[]) => Promise<void>;

export interface IndexedLinearSequenceGpuRuntime {
  readonly renderer: Renderer;
  readonly prepareLegacyGlyphs: LinearSequenceGlyphGpuPreparer;
}

interface LinearSequenceContentRequest {
  readonly generation: number;
  readonly sequence: string | undefined;
  readonly sequenceWindow: SequenceWindow | undefined;
  readonly startBp: number;
  readonly endBp: number;
  readonly readBase: BaseReader;
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface CharPosition {
  x: number;
  y: number;
  rotation: number;
}

type PositionCallback = (bp: number) => { fwd: CharPosition; rev: CharPosition };

interface ScreenBounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface RenderBaseRecord {
  bp: number;
  base: string;
  reverseBase: string;
  pos: { fwd: CharPosition; rev: CharPosition };
}

function isPositionInScreenBounds(pos: CharPosition, bounds: ScreenBounds): boolean {
  return (
    pos.x >= bounds.xMin && pos.x <= bounds.xMax && pos.y >= bounds.yMin && pos.y <= bounds.yMax
  );
}

interface NucleotideCellHighlight {
  readonly start: number;
  readonly end: number;
  readonly kind: 'insertion' | 'deletion' | 'substitution';
  readonly source: 'edited' | 'original';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: number;
}

interface NucleotideDeletionStrike {
  readonly start: number;
  readonly end: number;
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
}

interface LinearComparisonRowBounds {
  readonly forward: { readonly top: number; readonly bottom: number };
  readonly secondary: { readonly top: number; readonly bottom: number };
}

export class SequenceTrack {
  readonly container = new Container();
  private bg = new Graphics();
  private nucleotideStrike = new Graphics();
  private nucleotideHighlights: NucleotideCellHighlight[] = [];
  private nucleotideStrikes: NucleotideDeletionStrike[] = [];
  private comparisonRowBounds: LinearComparisonRowBounds | null = null;
  private fwdContainer = new Container();
  private revContainer = new Container();

  private preparedFwdContainer = new Container();
  private preparedRevContainer = new Container();

  fwdMap = new Map<number, Text>();
  revMap = new Map<number, Text>();
  private preparedFwdMap = new Map<number, Text>();
  private preparedRevMap = new Map<number, Text>();

  private fwdRecycle: Text[] = [];
  private revRecycle: Text[] = [];

  private lastVisibleBps = new Set<number>();
  private lastRequestedBaseCount = 0;
  private lastRenderedBaseCount = 0;
  private lastScreenCulledBaseCount = 0;
  private linearGeometryOriginBp: number | null = null;
  private linearGeometryPixelsPerBp: number | null = null;
  private linearRenderedStartBp: number | null = null;
  private linearRenderedEndBp: number | null = null;
  private linearDisplayScale: number | null = null;
  private linearFwdRelY: number | null = null;
  private linearRevRelY: number | null = null;
  private linearAlignedQuery: string | undefined;
  private linearReferenceRow: LinearSequencePresentation['referenceRow'];
  private linearNucleotideChanges: LinearSequencePresentation['nucleotideChanges'];
  private lastLinearNucleotideChanges: LinearSequencePresentation['nucleotideChanges'];
  private linearShowSecondaryRow = true;
  private lastLinearAlignedQuery: string | undefined;
  private lastLinearShowSecondaryRow = true;
  private linearFwdStyle: TextStyle | null = null;
  private linearRevStyle: TextStyle | null = null;
  private lastLinearGlyphUpdateCount = 0;
  private lastLinearGlyphRecycleCount = 0;
  private linearPrewarmIdleHandle: number | null = null;
  private linearPrewarmIdleIsTimeout = false;
  private linearGpuPrewarmSubmittedGlyphCount = 0;
  private linearGpuPrewarmCompletedGlyphCount = 0;
  private linearGpuPrewarmFailedGlyphCount = 0;
  private linearContentRequest: LinearSequenceContentRequest | null = null;
  private linearContentGeneration = 0;
  private linearContentNextBp: number | null = null;
  private linearContentGpuPendingBatches = 0;
  private linearContentGpuFailed = false;
  private linearContentReady = false;
  private linearContentPreparedPairCount = 0;
  private linearContentPresentationCount = 0;
  private linearContentDeferredPresentationCount = 0;
  private linearActiveSequence: string | undefined;
  private linearActiveSequenceWindow: SequenceWindow | undefined;
  private linearPreparedSequence: string | undefined;
  private linearPreparedSequenceWindow: SequenceWindow | undefined;
  private linearPresentationVisible = false;
  private arcActiveSequence: string | undefined;
  private arcActiveSequenceWindow: SequenceWindow | undefined;
  private arcActiveStrandOverrides: SequenceStrandOverride[] | undefined;
  private prepareLinearGlyphsForGpu?: LinearSequenceGlyphGpuPreparer;
  private retainedLinearNucleotideLayer: RetainedLinearNucleotideLayer | null;

  private sizedStyleCache = new Map<string, { fwd: TextStyle; rev: TextStyle }>();
  private nucleicAcid: NucleicAcid = 'dna';
  private complement: Readonly<Record<string, string>> = complementTable('dna');
  private theme = webglThemeForMode('light');
  private arcTextTheme: WebGLRenderTheme | null = null;
  private arcTextColor = 0x000000;
  private arcMutedTextColor = 0x888888;

  constructor(
    parentStage: Container,
    gpuPreparation?: LinearSequenceGlyphGpuPreparer | IndexedLinearSequenceGpuRuntime
  ) {
    this.prepareLinearGlyphsForGpu =
      typeof gpuPreparation === 'function' ? gpuPreparation : gpuPreparation?.prepareLegacyGlyphs;
    this.retainedLinearNucleotideLayer =
      typeof gpuPreparation === 'object' &&
      RetainedLinearNucleotideLayer.isSupported(gpuPreparation.renderer)
        ? new RetainedLinearNucleotideLayer(gpuPreparation.renderer, this.theme)
        : null;
    this.preparedFwdContainer.visible = false;
    this.preparedRevContainer.visible = false;
    this.container.addChild(
      this.bg,
      ...(this.retainedLinearNucleotideLayer ? [this.retainedLinearNucleotideLayer.container] : []),
      this.fwdContainer,
      this.revContainer,
      this.preparedFwdContainer,
      this.preparedRevContainer,
      this.nucleotideStrike
    );

    this.container.enableRenderGroup();
    parentStage.addChild(this.container);

    if (this.prepareLinearGlyphsForGpu && !this.retainedLinearNucleotideLayer) {
      this.prewarmLinearTextPool();
    }
  }

  getLinearComparisonRowBounds(): LinearComparisonRowBounds | null {
    return this.comparisonRowBounds;
  }

  getLinearPaintSnapshot() {
    return {
      kind: this.linearAlignedQuery === undefined ? ('sequence' as const) : ('alignment' as const),
      visible: this.linearPresentationVisible,
      forwardGlyphs: this.linearPresentationVisible ? this.lastRenderedBaseCount : 0,
      secondaryGlyphs:
        this.linearPresentationVisible && this.linearShowSecondaryRow
          ? this.lastRenderedBaseCount
          : 0,
      visibleStart: this.linearRenderedStartBp,
      visibleEnd: this.linearRenderedEndBp,
      queryRow: this.comparisonRowBounds
        ? {
            ...this.comparisonRowBounds[
              this.linearReferenceRow === 'forward' ? 'secondary' : 'forward'
            ],
          }
        : null,
    };
  }

  getDebugSnapshot(): {
    nucleotideHighlights: readonly NucleotideCellHighlight[];
    nucleotideStrikes: readonly NucleotideDeletionStrike[];
    glyphContract: typeof LINEAR_SEQUENCE_GLYPH_CONTRACT;
    fwdVisible: number;
    revVisible: number;
    fwdRecycle: number;
    revRecycle: number;
    fwdChildren: number;
    revChildren: number;
    fwdSample: Array<{ bp: number; text: string }>;
    revSample: Array<{ bp: number; text: string }>;
    lastRequestedBaseCount: number;
    lastRenderedBaseCount: number;
    lastScreenCulledBaseCount: number;
    renderGroupEnabled: boolean;
    linearGeometryOriginBp: number | null;
    linearGeometryPixelsPerBp: number | null;
    linearPanOffsetPx: number;
    linearRenderedStartBp: number | null;
    linearRenderedEndBp: number | null;
    lastLinearGlyphUpdateCount: number;
    lastLinearGlyphRecycleCount: number;
    linearGpuPrewarmSubmittedGlyphCount: number;
    linearGpuPrewarmCompletedGlyphCount: number;
    linearGpuPrewarmFailedGlyphCount: number;
    linearContentState: 'idle' | 'preparing' | 'ready' | 'failed';
    linearContentPreparedStartBp: number | null;
    linearContentPreparedEndBp: number | null;
    linearContentPreparedPairCount: number;
    linearContentGpuPendingBatches: number;
    linearContentPresentationCount: number;
    linearContentDeferredPresentationCount: number;
    linearRetainedFwdGlyphCount: number;
    linearRetainedRevGlyphCount: number;
    linearRenderOwner: typeof RETAINED_LINEAR_NUCLEOTIDE_OWNER | null;
    linearMeshCount: number;
    linearInstanceCount: number;
    linearContentBuildCount: number;
    linearCameraUniformUpdateCount: number;
  } {
    const retainedLayer = this.retainedLinearNucleotideLayer;
    const retained = retainedLayer?.diagnostics() ?? null;
    return {
      nucleotideHighlights: this.nucleotideHighlights.slice(),
      nucleotideStrikes: this.nucleotideStrikes.slice(),
      glyphContract: LINEAR_SEQUENCE_GLYPH_CONTRACT,
      fwdVisible: this.linearPresentationVisible ? this.lastRenderedBaseCount : 0,
      revVisible:
        this.linearPresentationVisible && this.linearShowSecondaryRow
          ? this.lastRenderedBaseCount
          : 0,
      fwdRecycle: this.fwdRecycle.length,
      revRecycle: this.revRecycle.length,
      fwdChildren: retained?.visible
        ? retained.meshCount
        : this.linearPresentationVisible
          ? this.fwdContainer.children.length
          : 0,
      revChildren: retained?.visible
        ? 0
        : this.linearPresentationVisible
          ? this.revContainer.children.length
          : 0,
      fwdSample: retained?.visible
        ? (retainedLayer?.sample('forward') ?? [])
        : this.sampleVisibleLetters(this.fwdMap),
      revSample: !this.linearShowSecondaryRow
        ? []
        : retained?.visible
          ? (retainedLayer?.sample('reverse') ?? [])
          : this.sampleVisibleLetters(this.revMap),
      lastRequestedBaseCount: this.lastRequestedBaseCount,
      lastRenderedBaseCount: this.lastRenderedBaseCount,
      lastScreenCulledBaseCount: this.lastScreenCulledBaseCount,
      renderGroupEnabled: this.container.isRenderGroup,
      linearGeometryOriginBp: this.linearGeometryOriginBp,
      linearGeometryPixelsPerBp: this.linearGeometryPixelsPerBp,
      linearPanOffsetPx: this.container.x,
      linearRenderedStartBp: this.linearRenderedStartBp,
      linearRenderedEndBp: this.linearRenderedEndBp,
      lastLinearGlyphUpdateCount: this.lastLinearGlyphUpdateCount,
      lastLinearGlyphRecycleCount: this.lastLinearGlyphRecycleCount,
      linearGpuPrewarmSubmittedGlyphCount: this.linearGpuPrewarmSubmittedGlyphCount,
      linearGpuPrewarmCompletedGlyphCount: this.linearGpuPrewarmCompletedGlyphCount,
      linearGpuPrewarmFailedGlyphCount: this.linearGpuPrewarmFailedGlyphCount,
      linearContentState: this.linearContentGpuFailed
        ? 'failed'
        : this.linearContentReady
          ? 'ready'
          : this.linearContentRequest
            ? 'preparing'
            : 'idle',
      linearContentPreparedStartBp: this.linearContentRequest?.startBp ?? null,
      linearContentPreparedEndBp: this.linearContentRequest?.endBp ?? null,
      linearContentPreparedPairCount:
        retained?.retainedBaseCount ?? this.linearContentPreparedPairCount,
      linearContentGpuPendingBatches: this.linearContentGpuPendingBatches,
      linearContentPresentationCount: this.linearContentPresentationCount,
      linearContentDeferredPresentationCount: this.linearContentDeferredPresentationCount,
      linearRetainedFwdGlyphCount: retained?.retainedBaseCount ?? this.fwdMap.size,
      linearRetainedRevGlyphCount: retained?.retainedBaseCount ?? this.revMap.size,
      linearRenderOwner: retained?.renderOwner ?? null,
      linearMeshCount: retained?.meshCount ?? 0,
      linearInstanceCount: retained?.instanceCount ?? 0,
      linearContentBuildCount: retained?.contentBuildCount ?? 0,
      linearCameraUniformUpdateCount: retained?.cameraUniformUpdateCount ?? 0,
    };
  }

  private sampleVisibleLetters(map: Map<number, Text>): Array<{ bp: number; text: string }> {
    return [...map.entries()]
      .filter(([, text]) => text.visible)
      .sort(([a], [b]) => a - b)
      .slice(0, 24)
      .map(([bp, text]) => ({ bp, text: String(text.text) }));
  }

  getLinearNucleotidePresentationAudit(
    viewStartBp: number,
    viewEndBp: number,
    sequence: string | undefined = this.linearActiveSequence,
    sequenceWindow: SequenceWindow | undefined = this.linearActiveSequenceWindow
  ): IndexedNucleotideGlyphPresentationAudit {
    if (this.retainedLinearNucleotideLayer) {
      return this.getRetainedLinearNucleotidePresentationAudit(
        viewStartBp,
        viewEndBp,
        sequence,
        sequenceWindow
      );
    }
    const startBp = Math.max(0, Math.floor(viewStartBp));
    const endBp = Math.max(startBp, Math.ceil(viewEndBp));
    const readBase = makeBaseReader(sequence, sequenceWindow, false, sequence?.length ?? 0);
    const visibleGlyphCount = this.linearPresentationVisible ? this.lastRenderedBaseCount : 0;
    const forward = this.emptyNucleotideGlyphStrandAudit(visibleGlyphCount);
    const reverse = this.emptyNucleotideGlyphStrandAudit(
      this.linearShowSecondaryRow ? visibleGlyphCount : 0
    );
    let sourceCoveredViewportBaseCount = 0;

    for (let bp = startBp; bp < endBp; bp += 1) {
      const sourceBase = readBase?.(bp);
      if (sourceBase === undefined) continue;
      sourceCoveredViewportBaseCount += 1;
      this.auditNucleotideGlyph(forward, this.fwdMap.get(bp), sourceBase, this.fwdContainer);
      if (this.linearShowSecondaryRow) {
        this.auditNucleotideGlyph(
          reverse,
          this.revMap.get(bp),
          this.linearAlignedQuery?.[bp] ?? this.complement[sourceBase] ?? 'n',
          this.revContainer
        );
      }
    }

    forward.requiredViewportGlyphCount = sourceCoveredViewportBaseCount;
    reverse.requiredViewportGlyphCount = this.linearShowSecondaryRow
      ? sourceCoveredViewportBaseCount
      : 0;
    return {
      contract: 'indexed-nucleotide-glyph-presentation.v1',
      glyphContract: LINEAR_SEQUENCE_GLYPH_CONTRACT,
      expectedFontFamily: SEQUENCE_FONT_FAMILY,
      viewportStartBp: startBp,
      viewportEndBp: endBp,
      requiredViewportBaseCount: Math.max(0, endBp - startBp),
      sourceCoveredViewportBaseCount,
      forward,
      reverse,
    };
  }

  getLinearNucleotideGpuOwnershipAudit(): RetainedLinearNucleotideGpuOwnershipAudit | null {
    return (
      this.retainedLinearNucleotideLayer?.gpuOwnershipAudit(
        this.lastRenderedBaseCount * (this.linearShowSecondaryRow ? 2 : 1)
      ) ?? null
    );
  }

  private getRetainedLinearNucleotidePresentationAudit(
    viewStartBp: number,
    viewEndBp: number,
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined
  ): IndexedNucleotideGlyphPresentationAudit {
    const startBp = Math.max(0, Math.floor(viewStartBp));
    const endBp = Math.max(startBp, Math.ceil(viewEndBp));
    const readBase = makeBaseReader(sequence, sequenceWindow, false, sequence?.length ?? 0);
    const retained = this.retainedLinearNucleotideLayer;
    if (!retained) throw new Error('Retained nucleotide presentation is unavailable');
    const diagnostics = retained.diagnostics();
    const visibleGlyphCount = this.linearPresentationVisible ? this.lastRenderedBaseCount : 0;
    const forward = this.emptyNucleotideGlyphStrandAudit(visibleGlyphCount);
    const reverse = this.emptyNucleotideGlyphStrandAudit(
      this.linearShowSecondaryRow ? visibleGlyphCount : 0
    );
    let sourceCoveredViewportBaseCount = 0;

    for (let bp = startBp; bp < endBp; bp += 1) {
      const sourceBase = readBase?.(bp);
      if (sourceBase === undefined) continue;
      sourceCoveredViewportBaseCount += 1;
      this.auditRetainedNucleotide(
        forward,
        retained.baseAt(bp, 'forward'),
        sourceBase.toLowerCase(),
        diagnostics.visible,
        diagnostics.fontFamily
      );
      if (this.linearShowSecondaryRow) {
        this.auditRetainedNucleotide(
          reverse,
          retained.baseAt(bp, 'reverse'),
          (this.linearAlignedQuery?.[bp] ?? this.complement[sourceBase] ?? 'n').toLowerCase(),
          diagnostics.visible,
          diagnostics.fontFamily
        );
      }
    }
    forward.requiredViewportGlyphCount = sourceCoveredViewportBaseCount;
    reverse.requiredViewportGlyphCount = this.linearShowSecondaryRow
      ? sourceCoveredViewportBaseCount
      : 0;
    return {
      contract: 'indexed-nucleotide-glyph-presentation.v1',
      glyphContract: LINEAR_SEQUENCE_GLYPH_CONTRACT,
      expectedFontFamily: SEQUENCE_FONT_FAMILY,
      viewportStartBp: startBp,
      viewportEndBp: endBp,
      requiredViewportBaseCount: Math.max(0, endBp - startBp),
      sourceCoveredViewportBaseCount,
      forward,
      reverse,
    };
  }

  private auditRetainedNucleotide(
    audit: {
      missingViewportBpCount: number;
      hiddenViewportGlyphCount: number;
      sourceMismatchCount: number;
      unknownSubstitutionCount: number;
      fallbackFontGlyphCount: number;
      invalidTextGlyphCount: number;
    },
    actualText: string | undefined,
    expectedText: string,
    visible: boolean,
    fontFamily: string
  ): void {
    if (actualText === undefined) {
      audit.missingViewportBpCount += 1;
      return;
    }
    if (!this.linearPresentationVisible || !visible) audit.hiddenViewportGlyphCount += 1;
    if (actualText !== expectedText) audit.sourceMismatchCount += 1;
    if (expectedText !== 'n' && actualText === 'n') audit.unknownSubstitutionCount += 1;
    if (fontFamily !== SEQUENCE_FONT_FAMILY) audit.fallbackFontGlyphCount += 1;
    if (
      actualText.length !== 1 ||
      !Object.prototype.hasOwnProperty.call(IUPAC_COMPLEMENT, actualText)
    ) {
      audit.invalidTextGlyphCount += 1;
    }
  }

  private emptyNucleotideGlyphStrandAudit(glyphCount: number): IndexedNucleotideGlyphStrandAudit & {
    requiredViewportGlyphCount: number;
    missingViewportBpCount: number;
    hiddenViewportGlyphCount: number;
    sourceMismatchCount: number;
    unknownSubstitutionCount: number;
    fallbackFontGlyphCount: number;
    invalidTextGlyphCount: number;
  } {
    return {
      glyphCount,
      requiredViewportGlyphCount: 0,
      missingViewportBpCount: 0,
      hiddenViewportGlyphCount: 0,
      sourceMismatchCount: 0,
      unknownSubstitutionCount: 0,
      fallbackFontGlyphCount: 0,
      invalidTextGlyphCount: 0,
    };
  }

  private auditNucleotideGlyph(
    audit: {
      missingViewportBpCount: number;
      hiddenViewportGlyphCount: number;
      sourceMismatchCount: number;
      unknownSubstitutionCount: number;
      fallbackFontGlyphCount: number;
      invalidTextGlyphCount: number;
    },
    glyph: Text | undefined,
    expectedText: string,
    expectedContainer: Container
  ): void {
    if (!glyph) {
      audit.missingViewportBpCount += 1;
      return;
    }
    const actualText = String(glyph.text);
    if (
      !this.linearPresentationVisible ||
      !expectedContainer.visible ||
      glyph.parent !== expectedContainer ||
      glyph.visible !== true ||
      glyph.renderable !== true ||
      glyph.alpha <= 0
    ) {
      audit.hiddenViewportGlyphCount += 1;
    }
    if (actualText !== expectedText) audit.sourceMismatchCount += 1;
    if (expectedText.toUpperCase() !== 'N' && actualText.toUpperCase() === 'N') {
      audit.unknownSubstitutionCount += 1;
    }
    if (String(glyph.style.fontFamily) !== SEQUENCE_FONT_FAMILY) {
      audit.fallbackFontGlyphCount += 1;
    }
    if (
      actualText.length !== 1 ||
      !Object.prototype.hasOwnProperty.call(IUPAC_COMPLEMENT, actualText)
    ) {
      audit.invalidTextGlyphCount += 1;
    }
  }

  getBackgroundDrawOpCount(): number {
    const ctx = (this.bg as unknown as { context?: { instructions?: unknown[] } }).context;
    return ctx?.instructions?.length ?? 0;
  }

  setNucleicAcid(acid: NucleicAcid): void {
    if (this.nucleicAcid === acid) return;
    this.nucleicAcid = acid;
    this.complement = complementTable(acid);
    this.retainedLinearNucleotideLayer?.setNucleicAcid(acid);
    this.hideAll();
  }

  setTheme(theme: WebGLRenderTheme): void {
    if (this.theme.mode === theme.mode) return;
    this.theme = theme;

    for (const t of this.fwdMap.values()) t.tint = theme.text;
    for (const t of this.revMap.values()) t.tint = theme.textMuted;
    for (const t of this.preparedFwdMap.values()) t.tint = theme.text;
    for (const t of this.preparedRevMap.values()) t.tint = theme.textMuted;
    this.retainedLinearNucleotideLayer?.setTheme(theme);
  }

  renderLinear(
    sequence: string | undefined,
    model: LayoutModel,
    screenWidth: number,
    sequenceWindow?: SequenceWindow,
    presentation?: LinearSequencePresentation
  ): { totalHeight: number; preparationPending: boolean } {
    this.bg.clear();
    this.bg.alpha = 1;
    this.nucleotideStrike.clear();
    this.nucleotideStrike.alpha = 1;
    this.nucleotideHighlights.length = 0;
    this.nucleotideStrikes.length = 0;
    this.comparisonRowBounds = null;
    const sourceEnd = sequenceWindow
      ? sequenceWindow.startBp + sequenceWindow.bases.length
      : (sequence?.length ?? 0);
    if (presentation?.alignedQuery !== undefined && presentation.alignedQuery.length < sourceEnd) {
      throw new Error('The aligned sequence row must cover every presented sequence column.');
    }
    this.linearAlignedQuery = presentation?.alignedQuery;
    this.linearReferenceRow = presentation?.referenceRow;
    this.linearNucleotideChanges = presentation?.nucleotideChanges;
    this.linearShowSecondaryRow =
      presentation?.alignedQuery !== undefined || presentation?.showReverseComplement !== false;

    if (this.retainedLinearNucleotideLayer) {
      return this.renderRetainedLinearNucleotides(
        sequence,
        model,
        screenWidth,
        sequenceWindow,
        presentation
      );
    }

    const haveSequenceData =
      (sequence && sequence.length > 0) || (sequenceWindow && sequenceWindow.bases.length > 0);
    if (!haveSequenceData || !model.sequenceVisible || model.sequenceOpacity <= 0) {
      if (haveSequenceData && !model.sequenceVisible) {
        this.prewarmLinearTextPool();
        this.prepareLinearContentNearReveal(sequence, sequenceWindow, model);
      }
      this.hideLinearPresentation();
      return {
        totalHeight: 0,
        preparationPending: this.needsLinearContentPreparation(),
      };
    }
    this.container.alpha = model.sequenceOpacity;

    this.container.y = model.fwdStrandTop;

    const totalHeight =
      (this.linearShowSecondaryRow ? model.revStrandBottom : model.fwdStrandBottom) -
      model.fwdStrandTop;

    void screenWidth;

    this.fwdContainer.x = 0;
    this.fwdContainer.y = 0;
    this.revContainer.x = 0;
    this.revContainer.y = 0;

    const overscanBp = Math.ceil(
      Math.max(64, model.sequenceFontSize * 8) / Math.max(model.pixelsPerBp, 0.0001)
    );
    const requestedRange = this.linearBaseRange(sequence, sequenceWindow, model, overscanBp);

    if (
      !this.prepareLinearGlyphsForGpu &&
      !this.linearActiveSourceMatches(sequence, sequenceWindow)
    ) {
      this.linearActiveSequence = sequence;
      this.linearActiveSequenceWindow = sequenceWindow;
    }
    if (
      !this.linearActiveCanUpdateIncrementally(sequence, sequenceWindow, requestedRange) &&
      !this.presentPreparedLinearContent(sequence, sequenceWindow, requestedRange)
    ) {
      this.requestLinearContent(sequence, sequenceWindow, requestedRange);
      this.linearContentDeferredPresentationCount += 1;
      this.hideLinearPresentation();
      return { totalHeight, preparationPending: true };
    }
    this.fwdContainer.visible = true;
    this.revContainer.visible = this.linearShowSecondaryRow;
    this.linearPresentationVisible = true;
    this._renderLinearBases(sequence, model, model.sequenceFontSize, {
      overscanBp,
      sequenceWindow,
    });
    this.paintNucleotideChanges(model, presentation);
    return {
      totalHeight,
      preparationPending: this.needsLinearContentPreparation(),
    };
  }

  private renderRetainedLinearNucleotides(
    sequence: string | undefined,
    model: LayoutModel,
    screenWidth: number,
    sequenceWindow: SequenceWindow | undefined,
    presentation?: LinearSequencePresentation
  ): { totalHeight: number; preparationPending: boolean } {
    const layer = this.retainedLinearNucleotideLayer;
    if (!layer) throw new Error('Retained nucleotide presentation is unavailable');
    const haveSequenceData =
      (sequence && sequence.length > 0) || (sequenceWindow && sequenceWindow.bases.length > 0);
    if (!haveSequenceData) {
      layer.clear();
      this.linearActiveSequence = undefined;
      this.linearActiveSequenceWindow = undefined;
      this.resetLinearGeometryState();
      this.hideLinearPresentation();
      return { totalHeight: 0, preparationPending: false };
    }
    if (!model.sequenceVisible || model.sequenceOpacity <= 0) {
      if (!model.sequenceVisible) {
        const preparationRange = this.linearPreparationRange(sequence, sequenceWindow, model);
        layer.prepare(
          sequence,
          sequenceWindow,
          preparationRange.startBp,
          preparationRange.endBp,
          presentation
        );
      }
      this.hideLinearPresentation();
      return { totalHeight: 0, preparationPending: false };
    }

    const totalHeight =
      (this.linearShowSecondaryRow ? model.revStrandBottom : model.fwdStrandBottom) -
      model.fwdStrandTop;
    const overscanBp = Math.ceil(
      Math.max(64, model.sequenceFontSize * 8) / Math.max(model.pixelsPerBp, 0.0001)
    );
    const requestedRange = this.linearBaseRange(sequence, sequenceWindow, model, overscanBp);
    if (!layer.covers(sequence, sequenceWindow, requestedRange, presentation)) {
      const preparationRange = this.linearPreparationRange(sequence, sequenceWindow, model);
      layer.prepare(
        sequence,
        sequenceWindow,
        preparationRange.startBp,
        preparationRange.endBp,
        presentation
      );
    }
    if (!layer.presentPrepared(sequence, sequenceWindow, requestedRange, presentation)) {
      this.hideLinearPresentation();
      return { totalHeight, preparationPending: true };
    }

    this.container.x = 0;
    this.container.y = 0;
    this.container.alpha = 1;
    layer.paint({
      viewStartBp: model.viewStartBp,
      pixelsPerBp: model.pixelsPerBp,
      forwardY: model.fwdStrandCenter,
      reverseY: model.revStrandCenter,
      displayFontSize: model.sequenceFontSize,
      viewportWidth: screenWidth,
      viewportHeight: model.viewportHeight,
      alpha: model.sequenceOpacity,
    });
    const diagnostics = layer.diagnostics();
    this.fwdContainer.visible = false;
    this.revContainer.visible = false;
    this.linearPresentationVisible = diagnostics.visible;
    this.linearActiveSequence = sequence;
    this.linearActiveSequenceWindow = sequenceWindow;
    this.lastRequestedBaseCount = Math.max(0, requestedRange.endBp - requestedRange.startBp);
    this.lastRenderedBaseCount = this.lastRequestedBaseCount;
    this.lastScreenCulledBaseCount = 0;
    this.lastLinearGlyphUpdateCount = 0;
    this.lastLinearGlyphRecycleCount = 0;
    this.linearGeometryOriginBp = diagnostics.startBp;
    this.linearGeometryPixelsPerBp = null;
    this.linearRenderedStartBp = requestedRange.startBp;
    this.linearRenderedEndBp = requestedRange.endBp;
    this.paintNucleotideChanges(model, presentation, model.sequenceOpacity);
    return { totalHeight, preparationPending: false };
  }

  private paintNucleotideChanges(
    model: LayoutModel,
    presentation?: LinearSequencePresentation,
    opacity = 1
  ): void {
    if (!presentation?.alignedQuery) return;
    this.bg.alpha = opacity;
    this.nucleotideStrike.alpha = opacity;
    const metrics =
      this.retainedLinearNucleotideLayer?.glyphVerticalMetrics() ??
      linearSequenceGlyphVerticalMetrics(
        this.stylesForRasterSize(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE).fwd
      );
    const scale = model.sequenceFontSize / LINEAR_SEQUENCE_GLYPH_RASTER_SIZE;
    const centerOffset = metrics ? ((metrics.top + metrics.bottom) * scale) / 2 : 0;
    const strikeOffset = metrics ? metrics.strikeY * scale : 0;
    const minimumHeight = metrics ? (metrics.bottom - metrics.top) * scale + 2 : 0;
    const rowBounds = (top: number, bottom: number, center: number) => {
      const height = Math.max(bottom - top, minimumHeight);
      return {
        top: center + centerOffset - height / 2,
        bottom: center + centerOffset + height / 2,
      };
    };
    this.comparisonRowBounds = {
      forward: rowBounds(model.fwdStrandTop, model.fwdStrandBottom, model.fwdStrandCenter),
      secondary: rowBounds(model.revStrandTop, model.revStrandBottom, model.revStrandCenter),
    };
    if (!presentation.nucleotideChanges?.length) return;
    const xAt = (column: number) => (column - model.viewStartBp) * model.pixelsPerBp;
    const referenceIsForward = presentation.referenceRow === 'forward';
    const referenceBaseAt = referenceIsForward
      ? makeBaseReader(this.linearActiveSequence, this.linearActiveSequenceWindow, false, 0)
      : (column: number) => presentation.alignedQuery?.[column];
    for (const change of presentation.nucleotideChanges) {
      const style = change.style ?? SEQUENCE_EDIT_MARKUP[change.kind];
      const start = Math.max(change.start, model.viewStartBp);
      const end = Math.min(change.end, model.viewEndBp);
      if (start >= end) continue;
      for (const source of ['edited', 'original'] as const) {
        const forward = (source === 'original') === referenceIsForward;
        const bounds = this.comparisonRowBounds[forward ? 'forward' : 'secondary'];
        const mark = {
          start,
          end,
          kind: change.kind,
          source,
          x: xAt(start),
          y: bounds.top,
          width: (end - start) * model.pixelsPerBp,
          height: bounds.bottom - bounds.top,
          color: style.background.color,
        };
        this.bg
          .rect(mark.x - this.container.x, mark.y - this.container.y, mark.width, mark.height)
          .fill({ color: mark.color, alpha: style.background.alpha });
        this.nucleotideHighlights.push(mark);
        if (!this.retainedLinearNucleotideLayer) {
          const map = forward ? this.fwdMap : this.revMap;
          for (let column = Math.floor(start); column < Math.ceil(end); column++) {
            const glyph = map.get(column);
            if (glyph) {
              glyph.tint = style.text.color;
              glyph.alpha = style.text.alpha;
            }
          }
        }
      }
      if (change.kind !== 'deletion') continue;
      let runStart: number | null = null;
      const drawStrike = (runEnd: number) => {
        if (runStart === null) return;
        const strike = {
          start: Math.max(start, runStart),
          end: Math.min(end, runEnd),
          x1: xAt(Math.max(start, runStart)),
          x2: xAt(Math.min(end, runEnd)),
          y: (referenceIsForward ? model.fwdStrandCenter : model.revStrandCenter) + strikeOffset,
        };
        this.nucleotideStrike
          .moveTo(strike.x1 - this.container.x, strike.y - this.container.y)
          .lineTo(strike.x2 - this.container.x, strike.y - this.container.y)
          .stroke(change.style?.strike ?? SEQUENCE_EDIT_MARKUP.deletion.strike);
        this.nucleotideStrikes.push(strike);
        runStart = null;
      };
      for (let column = Math.floor(start); column < Math.ceil(end); column++) {
        const base = referenceBaseAt?.(column);
        if (base && base !== '-') runStart ??= column;
        else drawStrike(column);
      }
      drawStrike(end);
    }
  }

  renderArc(
    sequence: string | undefined,
    viewStartBp: number,
    viewEndBp: number,
    bpPerPixel: number,
    positionFn: (bp: number) => { x: number; y: number; angle: number },
    zInv: number,
    complementPositionFn?: (bp: number) => { x: number; y: number; angle: number },
    options?: {
      wrap?: boolean;
      opacity?: number;
      sequenceWindow?: SequenceWindow;
      screenBounds?: ScreenBounds;
      strandOverrides?: SequenceStrandOverride[];
    }
  ): void {
    this.bg.clear();
    this.bg.alpha = 1;
    this.nucleotideStrike.clear();
    this.nucleotideHighlights.length = 0;
    this.nucleotideStrikes.length = 0;
    this.comparisonRowBounds = null;
    this.retainedLinearNucleotideLayer?.hide();
    this.linearAlignedQuery = undefined;
    this.linearNucleotideChanges = undefined;
    this.linearShowSecondaryRow = true;
    this.resetLinearGeometryState();

    const opacity = options?.opacity ?? sequenceOpacity(bpPerPixel);
    const haveSequenceData =
      (sequence && sequence.length > 0) ||
      (options?.sequenceWindow && options.sequenceWindow.bases.length > 0);
    if (!haveSequenceData || !shouldRenderSequence(bpPerPixel) || opacity <= 0) {
      this.hideAll();
      return;
    }

    this.container.alpha = opacity;
    this.container.x = 0;
    this.container.y = 0;
    this.fwdContainer.visible = true;
    this.revContainer.visible = true;
    this.linearPresentationVisible = true;

    const pixelsPerBp = 1 / bpPerPixel;
    const effectiveFontSize = (pixelsPerBp * 11) / 8;

    const worldFontSize = Math.max(4, effectiveFontSize * zInv);

    const arcPositionFn: PositionCallback = (bp) => {
      const fwdPos = positionFn(bp);
      const revPos = complementPositionFn ? complementPositionFn(bp) : fwdPos;
      return {
        fwd: { x: fwdPos.x, y: fwdPos.y, rotation: fwdPos.angle },
        rev: { x: revPos.x, y: revPos.y, rotation: revPos.angle },
      };
    };

    const overscanBp = Math.ceil(Math.max(96, effectiveFontSize * 10) / pixelsPerBp);
    const sourceChanged =
      this.arcActiveStrandOverrides !== options?.strandOverrides ||
      !sameSequenceSource(
        this.arcActiveSequence,
        this.arcActiveSequenceWindow,
        sequence,
        options?.sequenceWindow
      );
    this._renderBases(sequence, viewStartBp, viewEndBp, worldFontSize, arcPositionFn, {
      overscanBp,
      wrap: options?.wrap,
      sequenceWindow: options?.sequenceWindow,
      screenBounds: options?.screenBounds,
      refreshText: sourceChanged,
      strandOverrides: options?.strandOverrides,
    });
    this.arcActiveSequence = sequence;
    this.arcActiveSequenceWindow = options?.sequenceWindow;
    this.arcActiveStrandOverrides = options?.strandOverrides;
  }

  private _renderBases(
    sequence: string | undefined,
    viewStartBp: number,
    viewEndBp: number,
    fontSize: number,
    positionFn: PositionCallback,
    options?: {
      overscanBp?: number;
      wrap?: boolean;
      sequenceWindow?: SequenceWindow;
      screenBounds?: ScreenBounds;
      refreshText?: boolean;
      strandOverrides?: SequenceStrandOverride[];
    }
  ): void {
    const overscanBp = Math.max(0, Math.floor(options?.overscanBp ?? 0));
    const wrap = options?.wrap === true;
    const sequenceWindow = options?.sequenceWindow;
    let startBase = Math.floor(viewStartBp) - overscanBp;
    let endBase = Math.ceil(viewEndBp) + overscanBp;

    const seqLength = sequence?.length ?? 0;

    if (!wrap) {
      startBase = Math.max(0, startBase);
      if (sequenceWindow) {
        startBase = Math.max(startBase, sequenceWindow.startBp);
        endBase = Math.min(endBase, sequenceWindow.startBp + sequenceWindow.bases.length);
      } else if (seqLength > 0) {
        endBase = Math.min(seqLength, endBase);
      }
    } else if (seqLength > 0 && endBase - startBase > seqLength) {
      const center = Math.floor((startBase + endBase) / 2);
      const half = Math.floor(seqLength / 2);
      startBase = center - half;
      endBase = startBase + seqLength;
    }

    if (endBase - startBase > MAX_RENDERED_BASES_PER_STRAND) {
      const center = Math.floor((startBase + endBase) / 2);
      const halfWindow = Math.floor(MAX_RENDERED_BASES_PER_STRAND / 2);
      startBase = wrap ? center - halfWindow : Math.max(0, center - halfWindow);
      endBase = wrap
        ? startBase + MAX_RENDERED_BASES_PER_STRAND
        : seqLength > 0 && !sequenceWindow
          ? Math.min(seqLength, startBase + MAX_RENDERED_BASES_PER_STRAND)
          : startBase + MAX_RENDERED_BASES_PER_STRAND;
      if (sequenceWindow) {
        startBase = Math.max(startBase, sequenceWindow.startBp);
        endBase = Math.min(endBase, sequenceWindow.startBp + sequenceWindow.bases.length);
      }
    }

    const rasterSize = fontSize;
    const displayScale = 1;
    const { fwd: fwdStyle, rev: revStyle } = this.stylesForRasterSize(rasterSize);
    const anchorY = canvasMiddleTextAnchorY(fwdStyle);
    if (this.arcTextTheme !== this.theme) {
      const css =
        typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
      const foreground = css?.getPropertyValue('--color-fg').trim();
      const muted = css?.getPropertyValue('--color-fg-muted').trim();
      this.arcTextColor = new Color(
        foreground ? `hsl(${foreground})` : this.theme.mode === 'light' ? 0x000000 : this.theme.text
      ).toNumber();
      this.arcMutedTextColor = new Color(muted ? `hsl(${muted})` : this.theme.textMuted).toNumber();
      this.arcTextTheme = this.theme;
    }

    const readBase = makeBaseReader(sequence, sequenceWindow, wrap, seqLength);
    if (!readBase) {
      this.hideAll();
      return;
    }

    const currentBps = new Set<number>();
    const records: RenderBaseRecord[] = [];
    this.lastRequestedBaseCount = Math.max(0, endBase - startBase);
    this.lastRenderedBaseCount = 0;
    this.lastScreenCulledBaseCount = 0;
    for (let bp = startBase; bp < endBase; bp++) {
      const base = readBase(bp);
      if (!base) continue;
      const pos = positionFn(bp);
      if (
        options?.screenBounds &&
        !isPositionInScreenBounds(pos.fwd, options.screenBounds) &&
        !isPositionInScreenBounds(pos.rev, options.screenBounds)
      ) {
        this.lastScreenCulledBaseCount += 1;
        continue;
      }
      currentBps.add(bp);
      records.push({
        bp,
        pos,
        base: sequenceStrandOverrideAt(options?.strandOverrides, bp, seqLength, 'forward') ?? base,
        reverseBase:
          sequenceStrandOverrideAt(options?.strandOverrides, bp, seqLength, 'reverse') ??
          this.complement[base] ??
          'n',
      });
    }
    this.lastRenderedBaseCount = records.length;
    this.lastVisibleBps = currentBps;

    if (endBase <= startBase) {
      this.hideAll();
      return;
    }

    this.recycleOutsideSet(this.fwdMap, this.fwdRecycle, currentBps);
    this.recycleOutsideSet(this.revMap, this.revRecycle, currentBps);

    for (const { bp, base, reverseBase, pos } of records) {
      let fwd = this.fwdMap.get(bp);
      if (!fwd) {
        fwd = this.acquireText(this.fwdRecycle, fwdStyle, this.fwdContainer);
        fwd.visible = true;
        fwd.text = base;
        this.fwdMap.set(bp, fwd);
      } else if (options?.refreshText) {
        const forwardText = base;
        if (fwd.text !== forwardText) fwd.text = forwardText;
      }
      if (fwd.style !== fwdStyle) fwd.style = fwdStyle;
      if (fwd.tint !== this.arcTextColor) fwd.tint = this.arcTextColor;
      (fwd as any).__bp = bp;
      if (fwd.scale.x !== displayScale || fwd.scale.y !== displayScale) fwd.scale.set(displayScale);
      fwd.x = pos.fwd.x;
      fwd.y = pos.fwd.y;
      if (fwd.anchor.x !== 0.5 || fwd.anchor.y !== anchorY) fwd.anchor.set(0.5, anchorY);
      fwd.rotation = pos.fwd.rotation;

      const comp = reverseBase;
      let rev = this.revMap.get(bp);
      if (!rev) {
        rev = this.acquireText(this.revRecycle, revStyle, this.revContainer);
        rev.visible = true;
        rev.text = comp;
        this.revMap.set(bp, rev);
      } else if (options?.refreshText) {
        const reverseText = comp;
        if (rev.text !== reverseText) rev.text = reverseText;
      }
      if (rev.style !== revStyle) rev.style = revStyle;
      if (rev.tint !== this.arcMutedTextColor) rev.tint = this.arcMutedTextColor;
      (rev as any).__bp = bp;
      if (rev.scale.x !== displayScale || rev.scale.y !== displayScale) rev.scale.set(displayScale);
      rev.x = pos.rev.x;
      rev.y = pos.rev.y;
      if (rev.anchor.x !== 0.5 || rev.anchor.y !== anchorY) rev.anchor.set(0.5, anchorY);
      rev.rotation = pos.rev.rotation;
    }
  }

  private linearBaseRange(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    model: LayoutModel,
    overscanBp: number
  ): { startBp: number; endBp: number } {
    let startBp = Math.max(0, Math.floor(model.viewStartBp) - Math.max(0, overscanBp));
    let endBp = Math.ceil(model.viewEndBp) + Math.max(0, overscanBp);
    const sequenceLength = sequence?.length ?? 0;
    if (sequenceWindow) {
      startBp = Math.max(startBp, sequenceWindow.startBp);
      endBp = Math.min(endBp, sequenceWindow.startBp + sequenceWindow.bases.length);
    } else if (sequenceLength > 0) {
      endBp = Math.min(endBp, sequenceLength);
    }

    if (endBp - startBp > MAX_RENDERED_BASES_PER_STRAND) {
      const centerBp = Math.floor((startBp + endBp) / 2);
      const halfWindow = Math.floor(MAX_RENDERED_BASES_PER_STRAND / 2);
      startBp = Math.max(0, centerBp - halfWindow);
      endBp = sequenceWindow
        ? Math.min(
            sequenceWindow.startBp + sequenceWindow.bases.length,
            startBp + MAX_RENDERED_BASES_PER_STRAND
          )
        : sequenceLength > 0
          ? Math.min(sequenceLength, startBp + MAX_RENDERED_BASES_PER_STRAND)
          : startBp + MAX_RENDERED_BASES_PER_STRAND;
      if (sequenceWindow) startBp = Math.max(startBp, sequenceWindow.startBp);
    }
    return { startBp, endBp: Math.max(startBp, endBp) };
  }

  private linearPreparationRange(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    model: LayoutModel
  ): { startBp: number; endBp: number } {
    const centerBp = Math.floor((model.viewStartBp + model.viewEndBp) / 2);
    const halfWindow = Math.floor(MAX_RENDERED_BASES_PER_STRAND / 2);
    const sequenceLength = sequence?.length ?? 0;
    let startBp = Math.max(0, centerBp - halfWindow);
    let endBp = startBp + MAX_RENDERED_BASES_PER_STRAND;
    if (sequenceWindow) {
      startBp = Math.max(startBp, sequenceWindow.startBp);
      endBp = Math.min(endBp, sequenceWindow.startBp + sequenceWindow.bases.length);
    } else if (sequenceLength > 0) {
      endBp = Math.min(endBp, sequenceLength);
    }
    return { startBp, endBp: Math.max(startBp, endBp) };
  }

  private prepareLinearContentNearReveal(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    model: LayoutModel
  ): void {
    const revealPixelsPerBp = sequenceFullViewportPixelsPerBp(model.viewportWidth);
    if (model.pixelsPerBp < revealPixelsPerBp * LINEAR_SEQUENCE_CONTENT_PREP_START_FRACTION) {
      return;
    }
    const preparationRange = this.linearPreparationRange(sequence, sequenceWindow, model);
    if (this.linearActiveCanUpdateIncrementally(sequence, sequenceWindow, preparationRange)) return;
    this.requestLinearContent(sequence, sequenceWindow, preparationRange);
  }

  private linearActiveCanUpdateIncrementally(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    requestedRange: { startBp: number; endBp: number }
  ): boolean {
    if (!this.linearActiveSourceMatches(sequence, sequenceWindow)) return false;
    if (!this.prepareLinearGlyphsForGpu && this.linearRenderedStartBp === null) return true;
    if (this.linearRenderedStartBp === null || this.linearRenderedEndBp === null) return false;
    return (
      requestedRange.startBp < this.linearRenderedEndBp &&
      requestedRange.endBp > this.linearRenderedStartBp
    );
  }

  private linearActiveSourceMatches(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined
  ): boolean {
    return sameSequenceSource(
      this.linearActiveSequence,
      this.linearActiveSequenceWindow,
      sequence,
      sequenceWindow
    );
  }

  private requestLinearContent(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    range: { startBp: number; endBp: number }
  ): void {
    const readBase = makeBaseReader(sequence, sequenceWindow, false, sequence?.length ?? 0);
    if (!readBase || range.endBp <= range.startBp) return;
    const current = this.linearContentRequest;
    if (
      current !== null &&
      sameSequenceSource(current.sequence, current.sequenceWindow, sequence, sequenceWindow) &&
      current.startBp <= range.startBp &&
      current.endBp >= range.endBp
    ) {
      this.requestLinearPrewarmIdlePump();
      return;
    }

    const generation = ++this.linearContentGeneration;
    this.linearContentRequest = {
      generation,
      sequence,
      sequenceWindow,
      startBp: range.startBp,
      endBp: range.endBp,
      readBase,
    };
    this.linearContentNextBp = range.startBp;
    this.linearContentGpuPendingBatches = 0;
    this.linearContentGpuFailed = false;
    this.linearContentReady = false;
    this.linearContentPreparedPairCount = 0;
    this.requestLinearPrewarmIdlePump();
  }

  private preparedLinearContentCovers(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    range: { startBp: number; endBp: number }
  ): boolean {
    const request = this.linearContentRequest;
    return (
      this.linearContentReady &&
      request !== null &&
      sameSequenceSource(request.sequence, request.sequenceWindow, sequence, sequenceWindow) &&
      request.startBp <= range.startBp &&
      request.endBp >= range.endBp
    );
  }

  private presentPreparedLinearContent(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    requestedRange: { startBp: number; endBp: number }
  ): boolean {
    if (!this.preparedLinearContentCovers(sequence, sequenceWindow, requestedRange)) return false;

    const previousFwdContainer = this.fwdContainer;
    const previousRevContainer = this.revContainer;
    const previousFwdMap = this.fwdMap;
    const previousRevMap = this.revMap;
    const previousActiveSequence = this.linearActiveSequence;
    const previousActiveSequenceWindow = this.linearActiveSequenceWindow;

    previousFwdContainer.visible = false;
    previousRevContainer.visible = false;
    this.preparedFwdContainer.visible = true;
    this.preparedRevContainer.visible = true;
    this.fwdContainer = this.preparedFwdContainer;
    this.revContainer = this.preparedRevContainer;
    this.fwdMap = this.preparedFwdMap;
    this.revMap = this.preparedRevMap;
    this.preparedFwdContainer = previousFwdContainer;
    this.preparedRevContainer = previousRevContainer;
    this.preparedFwdMap = previousFwdMap;
    this.preparedRevMap = previousRevMap;
    this.linearPreparedSequence = previousActiveSequence;
    this.linearPreparedSequenceWindow = previousActiveSequenceWindow;

    this.linearActiveSequence = sequence;
    this.linearActiveSequenceWindow = sequenceWindow;
    this.linearContentRequest = null;
    this.linearContentNextBp = null;
    this.linearContentGpuPendingBatches = 0;
    this.linearContentGpuFailed = false;
    this.linearContentReady = false;
    this.linearContentPresentationCount += 1;
    this.linearPresentationVisible = true;
    this.resetLinearGeometryState();
    return true;
  }

  private needsLinearContentPreparation(): boolean {
    const request = this.linearContentRequest;
    if (!request || this.linearContentReady || this.linearContentGpuFailed) return false;
    if (this.linearContentNextBp !== null && this.linearContentNextBp < request.endBp) return true;
    for (const bp of this.preparedFwdMap.keys()) {
      if (bp < request.startBp || bp >= request.endBp) return true;
    }
    return this.linearContentGpuPendingBatches > 0;
  }

  private pumpLinearContentPreparation(
    deadline: LinearSequenceIdleDeadline,
    startedAt: number
  ): void {
    const request = this.linearContentRequest;
    if (!request || this.linearContentReady || this.linearContentGpuFailed) return;
    const remaining = () =>
      Math.min(
        deadline.didTimeout ? Number.POSITIVE_INFINITY : deadline.timeRemaining(),
        LINEAR_SEQUENCE_IDLE_PREWARM_BUDGET_MS - (nowMs() - startedAt)
      );
    let pairs = 0;

    const preparedSourceMatches = sameSequenceSource(
      this.linearPreparedSequence,
      this.linearPreparedSequenceWindow,
      request.sequence,
      request.sequenceWindow
    );

    for (const [bp, fwd] of this.preparedFwdMap) {
      if (
        pairs >= LINEAR_SEQUENCE_CONTENT_PREP_PAIRS_PER_SLICE ||
        remaining() <= LINEAR_SEQUENCE_IDLE_MIN_REMAINING_MS
      ) {
        break;
      }
      if (preparedSourceMatches && bp >= request.startBp && bp < request.endBp) continue;
      this.recycleText(fwd, this.fwdRecycle);
      this.preparedFwdMap.delete(bp);
      const rev = this.preparedRevMap.get(bp);
      if (rev) this.recycleText(rev, this.revRecycle);
      this.preparedRevMap.delete(bp);
      pairs += 1;
    }

    if (!preparedSourceMatches) {
      if (this.preparedFwdMap.size > 0 || this.preparedRevMap.size > 0) return;
      this.linearPreparedSequence = request.sequence;
      this.linearPreparedSequenceWindow = request.sequenceWindow;
      this.linearContentNextBp = request.startBp;
    }

    const { fwd: fwdStyle, rev: revStyle } = this.stylesForRasterSize(
      LINEAR_SEQUENCE_GLYPH_RASTER_SIZE
    );
    const preparedGlyphs: Text[] = [];
    let bp = this.linearContentNextBp ?? request.startBp;
    while (
      bp < request.endBp &&
      pairs < LINEAR_SEQUENCE_CONTENT_PREP_PAIRS_PER_SLICE &&
      remaining() > LINEAR_SEQUENCE_IDLE_MIN_REMAINING_MS
    ) {
      if (!this.preparedFwdMap.has(bp)) {
        const base = request.readBase(bp);
        if (base) {
          const fwd = this.acquireText(this.fwdRecycle, fwdStyle, this.preparedFwdContainer);
          configureLinearSequenceGlyph(fwd, {
            text: base,
            style: fwdStyle,
            tint: this.theme.text,
            displayFontSize: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
            x: 0,
            y: 0,
          });
          fwd.visible = false;
          (fwd as any).__bp = bp;
          this.preparedFwdMap.set(bp, fwd);
          preparedGlyphs.push(fwd);

          const rev = this.acquireText(this.revRecycle, revStyle, this.preparedRevContainer);
          configureLinearSequenceGlyph(rev, {
            text: this.complement[base] ?? 'n',
            style: revStyle,
            tint: this.theme.textMuted,
            displayFontSize: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
            x: 0,
            y: 0,
          });
          rev.visible = false;
          (rev as any).__bp = bp;
          this.preparedRevMap.set(bp, rev);
          preparedGlyphs.push(rev);
          this.linearContentPreparedPairCount += 1;
        }
      }
      bp += 1;
      pairs += 1;
    }
    this.linearContentNextBp = bp;
    this.submitLinearContentGpuPrewarm(preparedGlyphs, request.generation);
    this.updateLinearContentReady(request.generation);
  }

  private submitLinearContentGpuPrewarm(glyphs: readonly Text[], generation: number): void {
    if (glyphs.length === 0 || !this.prepareLinearGlyphsForGpu) return;
    this.linearContentGpuPendingBatches += 1;
    this.linearGpuPrewarmSubmittedGlyphCount += glyphs.length;
    let preparation: Promise<void>;
    try {
      preparation = this.prepareLinearGlyphsForGpu(glyphs);
    } catch {
      this.linearGpuPrewarmFailedGlyphCount += glyphs.length;
      this.linearContentGpuPendingBatches -= 1;
      this.linearContentGpuFailed = true;
      return;
    }
    void preparation.then(
      () => {
        this.linearGpuPrewarmCompletedGlyphCount += glyphs.length;
        if (generation !== this.linearContentRequest?.generation) return;
        this.linearContentGpuPendingBatches = Math.max(0, this.linearContentGpuPendingBatches - 1);
        this.updateLinearContentReady(generation);
      },
      () => {
        this.linearGpuPrewarmFailedGlyphCount += glyphs.length;
        if (generation !== this.linearContentRequest?.generation) return;
        this.linearContentGpuPendingBatches = Math.max(0, this.linearContentGpuPendingBatches - 1);
        this.linearContentGpuFailed = true;
        this.updateLinearContentReady(generation);
      }
    );
  }

  private updateLinearContentReady(generation: number): void {
    const request = this.linearContentRequest;
    if (!request || request.generation !== generation) return;
    if (this.linearContentGpuFailed) return;
    if ((this.linearContentNextBp ?? request.startBp) < request.endBp) return;
    if (this.linearContentGpuPendingBatches > 0) return;
    for (const bp of this.preparedFwdMap.keys()) {
      if (bp < request.startBp || bp >= request.endBp) return;
    }
    this.linearContentReady = true;
  }

  private _renderLinearBases(
    sequence: string | undefined,
    model: LayoutModel,
    fontSize: number,
    options?: { overscanBp?: number; sequenceWindow?: SequenceWindow }
  ): void {
    const sequenceWindow = options?.sequenceWindow;
    const readBase = makeBaseReader(sequence, sequenceWindow, false, sequence?.length ?? 0);
    if (!readBase) {
      this.hideAll();
      return;
    }

    let startBase = Math.max(
      0,
      Math.floor(model.viewStartBp) - Math.max(0, options?.overscanBp ?? 0)
    );
    let endBase = Math.ceil(model.viewEndBp) + Math.max(0, options?.overscanBp ?? 0);
    const seqLength = sequence?.length ?? 0;
    if (sequenceWindow) {
      startBase = Math.max(startBase, sequenceWindow.startBp);
      endBase = Math.min(endBase, sequenceWindow.startBp + sequenceWindow.bases.length);
    } else if (seqLength > 0) {
      endBase = Math.min(endBase, seqLength);
    }

    if (endBase - startBase > MAX_RENDERED_BASES_PER_STRAND) {
      const center = Math.floor((startBase + endBase) / 2);
      const halfWindow = Math.floor(MAX_RENDERED_BASES_PER_STRAND / 2);
      startBase = Math.max(0, center - halfWindow);
      endBase = sequenceWindow
        ? Math.min(
            sequenceWindow.startBp + sequenceWindow.bases.length,
            startBase + MAX_RENDERED_BASES_PER_STRAND
          )
        : seqLength > 0
          ? Math.min(seqLength, startBase + MAX_RENDERED_BASES_PER_STRAND)
          : startBase + MAX_RENDERED_BASES_PER_STRAND;
      if (sequenceWindow) startBase = Math.max(startBase, sequenceWindow.startBp);
    }

    if (endBase <= startBase) {
      this.hideAll();
      return;
    }

    const rasterSize = LINEAR_SEQUENCE_GLYPH_RASTER_SIZE;
    const displayScale = fontSize / rasterSize;
    const { fwd: fwdStyle, rev: revStyle } = this.stylesForRasterSize(rasterSize);
    const fwdRelY = model.fwdStrandCenter - model.fwdStrandTop;
    const revRelY = model.revStrandCenter - model.fwdStrandTop;
    const pixelsPerBp = model.pixelsPerBp;
    const viewportWidth = Math.max(1, model.viewportWidth);
    const previousOriginBp = this.linearGeometryOriginBp;
    const sameScale = this.linearGeometryPixelsPerBp === pixelsPerBp;
    const driftPx =
      previousOriginBp === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(model.viewStartBp - previousOriginBp) * pixelsPerBp;
    const shouldRebase =
      previousOriginBp === null ||
      !sameScale ||
      driftPx > viewportWidth * LINEAR_GEOMETRY_REBASE_VIEWPORTS;
    if (shouldRebase) {
      this.linearGeometryOriginBp = model.viewStartBp;
      this.linearGeometryPixelsPerBp = pixelsPerBp;
    }
    const geometryOriginBp = this.linearGeometryOriginBp;
    if (geometryOriginBp === null) return;
    this.container.x = (geometryOriginBp - model.viewStartBp) * pixelsPerBp;

    this.lastRequestedBaseCount = Math.max(0, endBase - startBase);
    this.lastScreenCulledBaseCount = 0;
    this.lastLinearGlyphUpdateCount = 0;
    this.lastLinearGlyphRecycleCount = 0;

    const previousStartBp = this.linearRenderedStartBp;
    const previousEndBp = this.linearRenderedEndBp;
    const rangesOverlap =
      previousStartBp !== null &&
      previousEndBp !== null &&
      startBase < previousEndBp &&
      endBase > previousStartBp;
    const visualGeometryChanged =
      this.lastLinearAlignedQuery !== this.linearAlignedQuery ||
      this.lastLinearNucleotideChanges !== this.linearNucleotideChanges ||
      this.lastLinearShowSecondaryRow !== this.linearShowSecondaryRow ||
      this.linearDisplayScale !== displayScale ||
      this.linearFwdRelY !== fwdRelY ||
      this.linearRevRelY !== revRelY ||
      this.linearFwdStyle !== fwdStyle ||
      this.linearRevStyle !== revStyle;
    const fullUpdate =
      shouldRebase ||
      !rangesOverlap ||
      previousStartBp === null ||
      previousEndBp === null ||
      visualGeometryChanged;

    if (previousStartBp !== null && previousEndBp !== null) {
      if (rangesOverlap) {
        this.hideLinearRange(previousStartBp, Math.min(startBase, previousEndBp));
        this.hideLinearRange(Math.max(endBase, previousStartBp), previousEndBp);
      } else {
        this.hideLinearRange(previousStartBp, previousEndBp);
      }
    }

    const currentRangeAlreadyRetained =
      this.fwdMap.has(startBase) &&
      this.fwdMap.has(endBase - 1) &&
      this.revMap.has(startBase) &&
      this.revMap.has(endBase - 1);
    if (!currentRangeAlreadyRetained && (this.fwdMap.size > 0 || this.revMap.size > 0)) {
      const retentionRange = this.linearRetentionRange(
        sequence,
        sequenceWindow,
        startBase,
        endBase
      );
      this.trimLinearRetention(retentionRange.startBp, retentionRange.endBp);
    }

    if (fullUpdate) {
      for (let bp = startBase; bp < endBase; bp += 1) {
        this.updateLinearGlyphPair(
          bp,
          readBase,
          geometryOriginBp,
          pixelsPerBp,
          fontSize,
          displayScale,
          fwdRelY,
          revRelY,
          fwdStyle,
          revStyle,
          true
        );
      }
    } else {
      for (let bp = startBase; bp < Math.min(previousStartBp, endBase); bp += 1) {
        this.updateLinearGlyphPair(
          bp,
          readBase,
          geometryOriginBp,
          pixelsPerBp,
          fontSize,
          displayScale,
          fwdRelY,
          revRelY,
          fwdStyle,
          revStyle,
          false
        );
      }
      for (let bp = Math.max(previousEndBp, startBase); bp < endBase; bp += 1) {
        this.updateLinearGlyphPair(
          bp,
          readBase,
          geometryOriginBp,
          pixelsPerBp,
          fontSize,
          displayScale,
          fwdRelY,
          revRelY,
          fwdStyle,
          revStyle,
          false
        );
      }
    }

    if (
      this.fwdMap.size > MAX_RENDERED_BASES_PER_STRAND ||
      this.revMap.size > MAX_RENDERED_BASES_PER_STRAND
    ) {
      const retentionRange = this.linearRetentionRange(
        sequence,
        sequenceWindow,
        startBase,
        endBase
      );
      this.trimLinearRetention(retentionRange.startBp, retentionRange.endBp);
    }

    this.linearRenderedStartBp = startBase;
    this.linearRenderedEndBp = endBase;
    this.linearDisplayScale = displayScale;
    this.linearFwdRelY = fwdRelY;
    this.linearRevRelY = revRelY;
    this.lastLinearAlignedQuery = this.linearAlignedQuery;
    this.lastLinearNucleotideChanges = this.linearNucleotideChanges;
    this.lastLinearShowSecondaryRow = this.linearShowSecondaryRow;
    this.linearFwdStyle = fwdStyle;
    this.linearRevStyle = revStyle;
    this.lastRenderedBaseCount = endBase - startBase;
  }

  private updateLinearGlyphPair(
    bp: number,
    readBase: BaseReader,
    geometryOriginBp: number,
    pixelsPerBp: number,
    fontSize: number,
    displayScale: number,
    fwdRelY: number,
    revRelY: number,
    fwdStyle: TextStyle,
    revStyle: TextStyle,
    forceGeometryUpdate: boolean
  ): void {
    const base = readBase(bp);
    if (!base) return;
    const x = (bp - geometryOriginBp) * pixelsPerBp + pixelsPerBp / 2;

    let fwd = this.fwdMap.get(bp);
    const isNewFwd = !fwd;
    if (!fwd) {
      fwd = this.acquireText(this.fwdRecycle, fwdStyle, this.fwdContainer);
      configureLinearSequenceGlyph(fwd, {
        text: base,
        style: fwdStyle,
        tint: this.theme.text,
        displayFontSize: fontSize,
        x,
        y: fwdRelY,
      });
      this.fwdMap.set(bp, fwd);
    }
    if (fwd.style !== fwdStyle) fwd.style = fwdStyle;
    if (fwd.tint !== this.theme.text) fwd.tint = this.theme.text;
    fwd.alpha = 1;
    (fwd as any).__bp = bp;
    if (fwd.scale.x !== displayScale || fwd.scale.y !== displayScale) {
      fwd.scale.set(displayScale);
    }
    if (isNewFwd || forceGeometryUpdate) fwd.x = x;
    if (fwd.y !== fwdRelY) fwd.y = fwdRelY;
    if (fwd.rotation !== 0) fwd.rotation = 0;
    fwd.visible = true;

    if (!this.linearShowSecondaryRow) {
      const rev = this.revMap.get(bp);
      if (rev) rev.visible = false;
      this.lastLinearGlyphUpdateCount += 1;
      return;
    }
    const comp = this.linearAlignedQuery?.[bp] ?? this.complement[base] ?? 'n';

    let rev = this.revMap.get(bp);
    const isNewRev = !rev;
    if (!rev) {
      rev = this.acquireText(this.revRecycle, revStyle, this.revContainer);
      configureLinearSequenceGlyph(rev, {
        text: comp,
        style: revStyle,
        tint: this.theme.textMuted,
        displayFontSize: fontSize,
        x,
        y: revRelY,
      });
      this.revMap.set(bp, rev);
    }
    if (rev.style !== revStyle) rev.style = revStyle;
    if (rev.text !== comp) rev.text = comp;
    if (rev.tint !== this.theme.textMuted) rev.tint = this.theme.textMuted;
    rev.alpha = 1;
    (rev as any).__bp = bp;
    if (rev.scale.x !== displayScale || rev.scale.y !== displayScale) {
      rev.scale.set(displayScale);
    }
    if (isNewRev || forceGeometryUpdate) rev.x = x;
    if (rev.y !== revRelY) rev.y = revRelY;
    if (rev.rotation !== 0) rev.rotation = 0;
    rev.visible = true;
    this.lastLinearGlyphUpdateCount += 1;
  }

  private hideLinearRange(startBp: number, endBp: number): void {
    for (let bp = startBp; bp < endBp; bp += 1) {
      const fwd = this.fwdMap.get(bp);
      if (fwd?.visible) fwd.visible = false;
      const rev = this.revMap.get(bp);
      if (rev?.visible) rev.visible = false;
    }
  }

  private linearRetentionRange(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    visibleStartBp: number,
    visibleEndBp: number
  ): { startBp: number; endBp: number } {
    const sourceStartBp = sequenceWindow?.startBp ?? 0;
    const sourceEndBp = sequenceWindow
      ? sequenceWindow.startBp + sequenceWindow.bases.length
      : (sequence?.length ?? visibleEndBp);
    const visibleWidth = Math.max(0, visibleEndBp - visibleStartBp);
    const spareWidth = Math.max(0, MAX_RENDERED_BASES_PER_STRAND - visibleWidth);
    let startBp = visibleStartBp - Math.floor(spareWidth / 2);
    let endBp = startBp + MAX_RENDERED_BASES_PER_STRAND;
    if (startBp < sourceStartBp) {
      endBp += sourceStartBp - startBp;
      startBp = sourceStartBp;
    }
    if (endBp > sourceEndBp) {
      startBp = Math.max(sourceStartBp, startBp - (endBp - sourceEndBp));
      endBp = sourceEndBp;
    }
    return { startBp, endBp: Math.max(startBp, endBp) };
  }

  private trimLinearRetention(startBp: number, endBp: number): void {
    for (const [bp, fwd] of this.fwdMap) {
      if (bp >= startBp && bp < endBp) continue;
      this.recycleText(fwd, this.fwdRecycle);
      this.fwdMap.delete(bp);
      const rev = this.revMap.get(bp);
      if (rev) {
        this.recycleText(rev, this.revRecycle);
        this.revMap.delete(bp);
      }
      this.lastLinearGlyphRecycleCount += 1;
    }
    for (const [bp, rev] of this.revMap) {
      if (bp >= startBp && bp < endBp) continue;
      this.recycleText(rev, this.revRecycle);
      this.revMap.delete(bp);
      this.lastLinearGlyphRecycleCount += 1;
    }
  }

  private resetLinearGeometryState(): void {
    this.linearGeometryOriginBp = null;
    this.linearGeometryPixelsPerBp = null;
    this.linearRenderedStartBp = null;
    this.linearRenderedEndBp = null;
    this.linearDisplayScale = null;
    this.linearFwdRelY = null;
    this.linearRevRelY = null;
    this.linearFwdStyle = null;
    this.linearRevStyle = null;
    this.lastLinearGlyphUpdateCount = 0;
    this.lastLinearGlyphRecycleCount = 0;
  }

  private recycleOutsideRange(
    map: Map<number, Text>,
    pool: Text[],
    startBase: number,
    endBase: number
  ): void {
    for (const [bp, text] of map) {
      if (bp >= startBase && bp < endBase) continue;
      this.recycleText(text, pool);
      map.delete(bp);
    }
  }

  private recycleOutsideSet(map: Map<number, Text>, pool: Text[], currentBps: Set<number>): void {
    for (const [bp, text] of map) {
      if (currentBps.has(bp)) continue;
      this.recycleText(text, pool);
      map.delete(bp);
    }
  }

  private stylesForRasterSize(rasterSize: number): { fwd: TextStyle; rev: TextStyle } {
    const key = `${rasterSize}`;
    const cached = this.sizedStyleCache.get(key);
    if (cached) {
      this.sizedStyleCache.delete(key);
      this.sizedStyleCache.set(key, cached);
      return cached;
    }
    const linearStyles =
      rasterSize === LINEAR_SEQUENCE_GLYPH_RASTER_SIZE ? createLinearSequenceGlyphStyles() : null;
    const neutral = linearStyles
      ? linearStyles.primary
      : new TextStyle({
          fontFamily: SEQUENCE_FONT_FAMILY,
          fontSize: rasterSize,
          lineHeight: rasterSize,
          fill: LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
        });
    const styles = { fwd: neutral, rev: neutral };
    this.sizedStyleCache.set(key, styles);
    while (this.sizedStyleCache.size > SIZED_STYLE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.sizedStyleCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.sizedStyleCache.delete(oldestKey);
    }
    return styles;
  }

  private _createText(style: TextStyle, container: Container): Text {
    return createLinearSequenceGlyph(style, container);
  }

  private acquireText(pool: Text[], style: TextStyle, container: Container): Text {
    const text = pool.pop();
    if (!text) return this._createText(style, container);
    if (text.parent !== container) container.addChild(text);
    return text;
  }

  private prewarmLinearTextPool(): void {
    const { fwd, rev } = this.stylesForRasterSize(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    this.prewarmRecyclePool(this.fwdRecycle, this.fwdMap.size, fwd, this.fwdContainer);
    this.prewarmRecyclePool(this.revRecycle, this.revMap.size, rev, this.revContainer);
    this.requestLinearPrewarmIdlePump();
  }

  private prewarmRecyclePool(
    pool: Text[],
    activeCount: number,
    style: TextStyle,
    container: Container,
    maxCount = LINEAR_SEQUENCE_PREWARM_BATCH_PER_STRAND
  ): number {
    const target = Math.min(
      LINEAR_SEQUENCE_PREWARM_TARGET_PER_STRAND,
      RECYCLE_POOL_LIMIT_PER_STRAND
    );

    const count = Math.min(maxCount, Math.max(0, target - pool.length - activeCount));
    for (let i = 0; i < count; i += 1) {
      const text = this._createText(style, container);
      text.visible = false;
      container.removeChild(text);
      pool.push(text);
    }
    return count;
  }

  private needsLinearPrewarm(): boolean {
    const target = Math.min(
      LINEAR_SEQUENCE_PREWARM_TARGET_PER_STRAND,
      RECYCLE_POOL_LIMIT_PER_STRAND
    );
    return (
      this.fwdRecycle.length + this.fwdMap.size < target ||
      this.revRecycle.length + this.revMap.size < target
    );
  }

  private requestLinearPrewarmIdlePump(): void {
    if (
      this.linearPrewarmIdleHandle !== null ||
      (!this.needsLinearContentPreparation() && !this.needsLinearPrewarm())
    ) {
      return;
    }
    const global = globalThis as LinearSequenceIdleGlobal;
    if (typeof global.requestIdleCallback === 'function') {
      this.linearPrewarmIdleIsTimeout = false;

      this.linearPrewarmIdleHandle = global.requestIdleCallback(
        (deadline) => this.pumpLinearPrewarmIdle(deadline),
        { timeout: LINEAR_SEQUENCE_IDLE_FORCE_PROGRESS_MS }
      );
      return;
    }
    this.linearPrewarmIdleIsTimeout = true;
    this.linearPrewarmIdleHandle = setTimeout(() => {
      const startedAt = nowMs();
      this.pumpLinearPrewarmIdle({
        didTimeout: false,
        timeRemaining: () =>
          Math.max(0, LINEAR_SEQUENCE_IDLE_PREWARM_BUDGET_MS - (nowMs() - startedAt)),
      });
    }, 0) as unknown as number;
  }

  private pumpLinearPrewarmIdle(deadline: LinearSequenceIdleDeadline): void {
    this.linearPrewarmIdleHandle = null;
    const startedAt = nowMs();
    const remaining = () =>
      Math.min(
        deadline.didTimeout ? Number.POSITIVE_INFINITY : deadline.timeRemaining(),
        LINEAR_SEQUENCE_IDLE_PREWARM_BUDGET_MS - (nowMs() - startedAt)
      );

    this.pumpLinearContentPreparation(deadline, startedAt);
    const { fwd, rev } = this.stylesForRasterSize(LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    let pairs = 0;
    while (
      pairs < LINEAR_SEQUENCE_IDLE_PREWARM_PAIRS_PER_SLICE &&
      remaining() > LINEAR_SEQUENCE_IDLE_MIN_REMAINING_MS &&
      !this.needsLinearContentPreparation() &&
      this.needsLinearPrewarm()
    ) {
      this.prewarmRecyclePool(this.fwdRecycle, this.fwdMap.size, fwd, this.fwdContainer, 1);
      this.prewarmRecyclePool(this.revRecycle, this.revMap.size, rev, this.revContainer, 1);
      pairs += 1;
    }
    this.requestLinearPrewarmIdlePump();
  }

  private cancelLinearPrewarmIdlePump(): void {
    if (this.linearPrewarmIdleHandle === null) return;
    const global = globalThis as LinearSequenceIdleGlobal;
    if (this.linearPrewarmIdleIsTimeout) {
      clearTimeout(this.linearPrewarmIdleHandle as unknown as ReturnType<typeof setTimeout>);
    } else {
      global.cancelIdleCallback?.(this.linearPrewarmIdleHandle);
    }
    this.linearPrewarmIdleHandle = null;
  }

  private recycleText(text: Text, pool: Text[]): void {
    text.visible = false;
    if (pool.length < RECYCLE_POOL_LIMIT_PER_STRAND) {
      text.parent?.removeChild(text);
      pool.push(text);
      return;
    }
    text.parent?.removeChild(text);
    destroyPixiText(text);
  }

  private recycleDetachedText(text: Text, pool: Text[]): void {
    text.visible = false;
    if (pool.length < RECYCLE_POOL_LIMIT_PER_STRAND) {
      pool.push(text);
      return;
    }
    destroyPixiText(text);
  }

  private hideLinearPresentation(): void {
    this.fwdContainer.visible = false;
    this.revContainer.visible = false;
    this.linearPresentationVisible = false;
    this.container.alpha = 0;
    this.retainedLinearNucleotideLayer?.hide();
    this.lastRequestedBaseCount = 0;
    this.lastRenderedBaseCount = 0;
    this.lastScreenCulledBaseCount = 0;
    this.lastLinearGlyphUpdateCount = 0;
    this.lastLinearGlyphRecycleCount = 0;
  }

  private hideAll(): void {
    this.fwdContainer.removeChildren();
    this.revContainer.removeChildren();
    this.preparedFwdContainer.removeChildren();
    this.preparedRevContainer.removeChildren();
    this.retainedLinearNucleotideLayer?.clear();
    for (const [, t] of this.fwdMap) {
      this.recycleDetachedText(t, this.fwdRecycle);
    }
    for (const [, t] of this.revMap) {
      this.recycleDetachedText(t, this.revRecycle);
    }
    this.fwdMap.clear();
    this.revMap.clear();
    for (const [, t] of this.preparedFwdMap) {
      this.recycleDetachedText(t, this.fwdRecycle);
    }
    for (const [, t] of this.preparedRevMap) {
      this.recycleDetachedText(t, this.revRecycle);
    }
    this.preparedFwdMap.clear();
    this.preparedRevMap.clear();
    this.fwdContainer.visible = false;
    this.revContainer.visible = false;
    this.preparedFwdContainer.visible = false;
    this.preparedRevContainer.visible = false;
    this.linearPresentationVisible = false;
    this.linearActiveSequence = undefined;
    this.linearActiveSequenceWindow = undefined;
    this.linearPreparedSequence = undefined;
    this.linearPreparedSequenceWindow = undefined;
    this.linearContentRequest = null;
    this.linearContentNextBp = null;
    this.linearContentGpuPendingBatches = 0;
    this.linearContentGpuFailed = false;
    this.linearContentReady = false;
    this.lastVisibleBps.clear();
    this.lastRequestedBaseCount = 0;
    this.lastRenderedBaseCount = 0;
    this.lastScreenCulledBaseCount = 0;
    this.resetLinearGeometryState();
  }

  destroy(): void {
    this.cancelLinearPrewarmIdlePump();
    this.linearContentGeneration += 1;
    this.hideAll();
    for (const [, t] of this.fwdMap) destroyPixiText(t);
    for (const [, t] of this.preparedFwdMap) destroyPixiText(t);
    for (const t of this.fwdRecycle) destroyPixiText(t);
    for (const [, t] of this.revMap) destroyPixiText(t);
    for (const [, t] of this.preparedRevMap) destroyPixiText(t);
    for (const t of this.revRecycle) destroyPixiText(t);
    this.fwdMap.clear();
    this.preparedFwdMap.clear();
    this.fwdRecycle.length = 0;
    this.revMap.clear();
    this.preparedRevMap.clear();
    this.revRecycle.length = 0;
    this.sizedStyleCache.clear();
    this.prepareLinearGlyphsForGpu = undefined;
    if (this.retainedLinearNucleotideLayer) {
      if (this.retainedLinearNucleotideLayer.container.parent === this.container) {
        this.container.removeChild(this.retainedLinearNucleotideLayer.container);
      }
      this.retainedLinearNucleotideLayer.destroy();
      this.retainedLinearNucleotideLayer = null;
    }
    this.bg.destroy();
    this.nucleotideStrike.destroy();
    this.container.destroy({ children: true });
  }
}
