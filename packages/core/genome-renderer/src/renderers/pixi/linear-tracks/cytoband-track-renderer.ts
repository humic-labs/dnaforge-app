import { Container, Graphics, Rectangle, Text } from 'pixi.js';

import type { AssemblyChromosomePlacement } from '../../../assembly';
import { BUILTIN_TRACK_TYPES } from '../../../tracks/builtins';
import {
  CYTOBAND_LABEL_FONT_SIZE_PX,
  CYTOBAND_LABEL_LINE_HEIGHT_PX,
  CYTOBAND_VERTICAL_CONTRACT_TOKEN,
  computeCytobandVerticalLayout,
  type CytobandVerticalLayout,
} from '../../../tracks/cytoband-vertical-layout';
import { webglThemeForMode, type WebGLThemeMode } from '../shared/theme';
import {
  computeBetweenMemberSilhouetteGeometry,
  computeCapsuleSilhouetteGeometry,
  computeCentromereBoundarySilhouetteGeometry,
  computeChromosomeSilhouetteGeometry,
  computeSchematicChromosomeSilhouetteGeometry,
  type CapsuleSilhouetteGeometry,
  type ChromosomeSilhouetteGeometry,
  type TerminalCentromereCapGeometry,
} from './cytoband-silhouette-geometry';
import {
  compactCytobandLabel,
  estimateCytobandLabelWidthPx,
  findCytobandLabelIndexAtX,
  layoutCytobandLabels,
  type CytobandLabelLayout,
} from './cytoband-label-layout';
import { destroyPixiText } from '../shared/pixi-text-lifecycle';
import type {
  BpRange,
  PixiLinearTrackRenderer,
  TrackHitArgs,
  TrackHitResult,
  TrackHoverArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';

const HEADER_FONT_SIZE = CYTOBAND_LABEL_FONT_SIZE_PX;
const HEADER_LINE_HEIGHT = CYTOBAND_LABEL_LINE_HEIGHT_PX;
const LABEL_HIT_PADDING_X_PX = 6;
const CIRCLE_BEZIER_KAPPA = 0.552_284_749_8;
const CENTROMERE_OUTER_CONTROL_RATIO = 0.55;
const CENTROMERE_INNER_CONTROL_RATIO = 0.15;
const HEADER_COLOR = '#3730a3';
const DARK_HEADER_COLOR = '#e0e7ff';
const HEADER_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const FULL_VIEW_COLOR = 0x4338ca;
const VIEWPORT_INDICATOR_COLOR = 0x4a40d2;
const DARK_VIEWPORT_INDICATOR_COLOR = 0x6366f1;
const UNFOCUSED_WHITE_MIX_RATIO = 0.5;
const DARK_UNFOCUSED_WHITE_MIX_RATIO = 0.44;
const STRIP_FILL_COLOR = rgbColorToHex(mixRgbWithWhite(FULL_VIEW_COLOR, UNFOCUSED_WHITE_MIX_RATIO));
const DARK_STRIP_FILL_COLOR = rgbColorToHex(
  mixRgbWithWhite(DARK_VIEWPORT_INDICATOR_COLOR, DARK_UNFOCUSED_WHITE_MIX_RATIO)
);
const VIEWPORT_INDICATOR_ALPHA = 1;
const HOVER_COLOR = VIEWPORT_INDICATOR_COLOR;
const DARK_HOVER_COLOR = DARK_VIEWPORT_INDICATOR_COLOR;
const HOVER_ALPHA = 1;
const LABEL_HOVER_TEXT_COLOR = rgbColorToHex(VIEWPORT_INDICATOR_COLOR);
const DARK_LABEL_HOVER_TEXT_COLOR = rgbColorToHex(DARK_VIEWPORT_INDICATOR_COLOR);
const GENERIC_CONTIG_SEPARATOR_WIDTH_PX = 1;
const VIEWPORT_INDICATOR_MIN_WIDTH_PX = 2;
const FULL_VIEW_EDGE_EPSILON_PX = 0.5;

function mixRgbWithWhite(color: number, whiteRatio: number): number {
  return [16, 8, 0].reduce((mixedColor, shift) => {
    const channel = (color >> shift) & 0xff;
    const mixedChannel = Math.round(channel + (0xff - channel) * whiteRatio);
    return mixedColor | (mixedChannel << shift);
  }, 0);
}

function rgbColorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

interface CytobandPalette {
  header: string;
  stripFill: string;
  fullViewFill: string;
  viewportIndicator: number;
  viewportIndicatorAlpha: number;
  hover: number;
  hoverAlpha: number;
  labelHoverText: string;
  separator: number;
}

export function cytobandPaletteForTheme(mode: WebGLThemeMode | undefined): CytobandPalette {
  if (mode === 'dark') {
    return {
      header: DARK_HEADER_COLOR,
      stripFill: DARK_STRIP_FILL_COLOR,
      fullViewFill: rgbColorToHex(DARK_VIEWPORT_INDICATOR_COLOR),
      viewportIndicator: DARK_VIEWPORT_INDICATOR_COLOR,
      viewportIndicatorAlpha: VIEWPORT_INDICATOR_ALPHA,
      hover: DARK_HOVER_COLOR,
      hoverAlpha: HOVER_ALPHA,
      labelHoverText: DARK_LABEL_HOVER_TEXT_COLOR,
      separator: webglThemeForMode(mode).background,
    };
  }
  return {
    header: HEADER_COLOR,
    stripFill: STRIP_FILL_COLOR,
    fullViewFill: rgbColorToHex(FULL_VIEW_COLOR),
    viewportIndicator: VIEWPORT_INDICATOR_COLOR,
    viewportIndicatorAlpha: VIEWPORT_INDICATOR_ALPHA,
    hover: HOVER_COLOR,
    hoverAlpha: HOVER_ALPHA,
    labelHoverText: LABEL_HOVER_TEXT_COLOR,
    separator: webglThemeForMode(mode).background,
  };
}

interface CytobandContainerState {
  bodyGfx: Graphics;
  separatorGfx: Graphics;
  hoverIndicator: ViewportIndicatorState;
  indicator: ViewportIndicatorState;
  labelTexts: Text[];
  themeMode: WebGLThemeMode;
  palette: CytobandPalette;
  bodyFillColor: string;
  geometryKey?: string;
  verticalLayout?: CytobandVerticalLayout;
  morphology: CytobandMorphologyDiagnostic[];
  labelLayouts: CytobandLabelLayout[];
  sourceCytobandCount: number;
  dividerLineCount: number;
  bodyFillCount: number;
  viewportIndicatorLayout: ViewportIndicatorLayout | null;
  hoverPreviewLayout: HoverPreviewLayout | null;
  viewportRangeKey?: string;
  hoveredLabelIndex: number | null;
  morphologySource?: object;
  morphologySignature?: string;
}

export interface ViewportIndicatorLayout {
  readonly startBp: number;
  readonly endBp: number;
  readonly leftPx: number;
  readonly widthPx: number;
}

type HoverPreviewMode = 'chromosome-frame' | 'viewport-pan';

interface HoverPreviewLayout extends ViewportIndicatorLayout {
  readonly mode: HoverPreviewMode;
  readonly chromosomeId: string | null;
}

interface ViewportIndicatorState {
  root: Container;
  highlight: Graphics;
  clip: Graphics;
  geometryBuildCount: number;
}

export interface CytobandTrackDiagnostics {
  themeMode: WebGLThemeMode;
  headerColor: string;
  stripFillColor: string;
  stripOutlineWidthPx: number;
  viewportIndicatorColor: number;
  viewportIndicatorAlpha: number;
  viewportIndicatorMode: 'silhouette-recolor';
  viewportIndicatorClipHeightPx: number;
  hoverPreviewMode: HoverPreviewMode | null;
  hoverPreviewStartBp: number | null;
  hoverPreviewEndBp: number | null;
  hoverPreviewLeftPx: number | null;
  hoverPreviewWidthPx: number | null;
  hoveredChromosomeId: string | null;
  hoverPreviewColor: number | null;
  hoverPreviewAlpha: number | null;
  chromosomeCount: number;
  visibleLabelCount: number;
  hiddenLabelCount: number;
  allocatedHeightPx: number;
  labelTopPx: number;
  labelBottomPx: number;
  contentBottomPx: number;
  requiredTrackHeightPx: number;
  overflowPx: number;
  labelsFit: boolean;
  viewportIndicatorGeometryBuildCount: number;
  viewportStartBp: number | null;
  viewportEndBp: number | null;
  viewportIndicatorLeftPx: number | null;
  viewportIndicatorWidthPx: number | null;
  silhouetteChromosomeCount: number;
  genericContigCount: number;
  sourceCytobandCount: number;
  legacyCytobandFillCount: 0;
  bodyFillCount: number;
  dividerLineCount: number;
  morphology: ReadonlyArray<CytobandMorphologyDiagnostic>;
  labelLayouts: ReadonlyArray<CytobandLabelLayout>;
}

export type CytobandMorphologyDiagnostic =
  | {
      readonly chromosomeId: string;
      readonly kind: 'chromosome-silhouette';
      readonly morphologyKind:
        | 'localized'
        | 'localized-boundary'
        | 'schematic'
        | 'holocentric'
        | 'unlocalized-centromere'
        | 'between-members';
      readonly leftPx: number;
      readonly rightPx: number;
      readonly centromereStartPx?: number;
      readonly centromereEndPx?: number;
    }
  | {
      readonly chromosomeId: string;
      readonly kind: 'generic-contig';
      readonly leftPx: number;
      readonly rightPx: number;
    };

function resolvePlacements(args: {
  assembly?: TrackPaintArgs['assembly'];
  chromosome: TrackPaintArgs['chromosome'];
}): { placements: ReadonlyArray<AssemblyChromosomePlacement>; totalLengthBp: number } {
  if (args.assembly && args.assembly.chromosomes.length > 0) {
    return { placements: args.assembly.chromosomes, totalLengthBp: args.assembly.totalLengthBp };
  }
  const c = args.chromosome;
  return {
    placements: [{ chromosome: c, globalStartBp: 0, globalEndBp: c.length, order: 0 }],
    totalLengthBp: c.length,
  };
}

export class PixiCytobandTrackRenderer implements PixiLinearTrackRenderer<unknown> {
  readonly type = BUILTIN_TRACK_TYPES.cytoband;

  private containerState = new WeakMap<Container, CytobandContainerState>();

  mount(args: TrackMountArgs): Container {
    const container = new Container();
    const bodyGfx = new Graphics();
    const separatorGfx = new Graphics();
    const hoverIndicator = createViewportIndicator();
    hoverIndicator.root.visible = false;
    const indicator = createViewportIndicator();
    const palette = cytobandPaletteForTheme(args.theme.mode);
    container.addChild(bodyGfx);
    container.addChild(indicator.root);
    container.addChild(hoverIndicator.root);
    container.addChild(separatorGfx);
    this.containerState.set(container, {
      bodyGfx,
      separatorGfx,
      hoverIndicator,
      indicator,
      labelTexts: [],
      themeMode: args.theme.mode,
      palette,
      bodyFillColor: palette.fullViewFill,
      morphology: [],
      labelLayouts: [],
      sourceCytobandCount: 0,
      dividerLineCount: 0,
      bodyFillCount: 0,
      viewportIndicatorLayout: null,
      hoverPreviewLayout: null,
      hoveredLabelIndex: null,
    });
    return container;
  }

  hitTest(args: TrackHitArgs): TrackHitResult | null {
    const { localX, localY, viewportWidthPx } = args;
    if (localX < 0 || localX > viewportWidthPx || viewportWidthPx <= 0) return null;
    const { placements, totalLengthBp } = resolvePlacements(args);
    if (totalLengthBp <= 0) return null;
    const verticalLayout = computeCytobandVerticalLayout(args.layoutEntry.height);
    if (
      verticalLayout.labelsFit &&
      localY >= verticalLayout.labelTopPx &&
      localY <= verticalLayout.labelBottomPx
    ) {
      const labelLayouts = computeLabelLayouts(placements, totalLengthBp, viewportWidthPx, true);
      const target = findLabelTarget(placements, labelLayouts, localX);
      if (!target) return null;
      return {
        kind: 'frame-bp-range',
        startBp: target.placement.globalStartBp,
        endBp: target.placement.globalEndBp,
        chromosomeId: target.placement.chromosome.id,
      };
    }
    if (localY < 0 || localY > verticalLayout.bandHeightPx) return null;
    const bpRaw = (localX / viewportWidthPx) * totalLengthBp;
    const bp = Math.max(0, Math.min(totalLengthBp, Math.round(bpRaw)));
    return { kind: 'jump-to-bp', bp };
  }

  updateHover(args: TrackHoverArgs): void {
    const state = this.containerState.get(args.container);
    if (!state) return;
    const { placements, totalLengthBp } = resolvePlacements(args);
    const { localX, localY, viewportWidthPx } = args;
    if (totalLengthBp <= 0 || viewportWidthPx <= 0 || localX < 0 || localX > viewportWidthPx) {
      this.clearHover(args.container);
      return;
    }
    const verticalLayout = computeCytobandVerticalLayout(args.layoutEntry.height);
    if (
      verticalLayout.labelsFit &&
      localY >= verticalLayout.labelTopPx &&
      localY <= verticalLayout.labelBottomPx
    ) {
      const target = findLabelTarget(placements, state.labelLayouts, localX);
      if (!target) {
        this.clearHover(args.container);
        return;
      }
      const { labelIndex, placement } = target;
      if (
        state.hoveredLabelIndex === labelIndex &&
        state.hoverPreviewLayout?.mode === 'chromosome-frame' &&
        state.hoverPreviewLayout.chromosomeId === placement.chromosome.id
      ) {
        args.container.cursor = 'zoom-in';
        return;
      }
      setHoveredLabel(state, labelIndex);
      state.hoverIndicator.highlight.tint = state.palette.hover;
      state.hoverIndicator.highlight.alpha = state.palette.hoverAlpha;
      const preview = paintViewportIndicator(
        state.hoverIndicator,
        placement.globalStartBp,
        placement.globalEndBp,
        totalLengthBp,
        viewportWidthPx,
        verticalLayout.bandHeightPx
      );
      state.hoverPreviewLayout = preview
        ? {
            ...preview,
            mode: 'chromosome-frame',
            chromosomeId: placement.chromosome.id,
          }
        : null;
      args.container.cursor = 'zoom-in';
      return;
    }

    if (localY >= 0 && localY <= verticalLayout.bandHeightPx) {
      setHoveredLabel(state, null);
      const viewportSpanBp = Math.min(
        totalLengthBp,
        Math.max(0, args.viewportBpRange.end - args.viewportBpRange.start)
      );
      if (viewportSpanBp <= 0) {
        this.clearHover(args.container);
        return;
      }
      const centerBp = (localX / viewportWidthPx) * totalLengthBp;
      const previewRange = centerRangeWithinBounds(centerBp, viewportSpanBp, totalLengthBp);
      state.hoverIndicator.highlight.tint = state.palette.hover;
      state.hoverIndicator.highlight.alpha = state.palette.hoverAlpha;
      const preview = paintViewportIndicator(
        state.hoverIndicator,
        previewRange.start,
        previewRange.end,
        totalLengthBp,
        viewportWidthPx,
        verticalLayout.bandHeightPx
      );
      state.hoverPreviewLayout = preview
        ? { ...preview, mode: 'viewport-pan', chromosomeId: null }
        : null;
      args.container.cursor = 'pointer';
      return;
    }

    this.clearHover(args.container);
  }

  clearHover(container: Container): void {
    const state = this.containerState.get(container);
    if (!state) return;
    state.hoverIndicator.root.visible = false;
    state.hoverPreviewLayout = null;
    setHoveredLabel(state, null);
    container.cursor = 'default';
  }

  paint(args: TrackPaintArgs<unknown>): void {
    const state = this.containerState.get(args.container);
    if (!state) return;

    const { viewportBpRange, viewportWidthPx, layoutEntry } = args;
    const palette = cytobandPaletteForTheme(args.theme.mode);
    const themeChanged = state.themeMode !== args.theme.mode;
    state.themeMode = args.theme.mode;
    state.palette = palette;

    const { placements, totalLengthBp } = resolvePlacements(args);
    const viewportRangeKey = `${viewportBpRange.start}:${viewportBpRange.end}`;
    if (
      state.viewportRangeKey !== undefined &&
      state.viewportRangeKey !== viewportRangeKey &&
      state.hoverPreviewLayout?.mode === 'viewport-pan'
    ) {
      this.clearHover(args.container);
    }
    state.viewportRangeKey = viewportRangeKey;

    const verticalLayout = computeCytobandVerticalLayout(layoutEntry.height);
    const bandHeightPx = verticalLayout.bandHeightPx;
    state.verticalLayout = verticalLayout;
    const viewportIndicatorLayout = resolveViewportIndicatorLayout(
      viewportBpRange.start,
      viewportBpRange.end,
      totalLengthBp,
      viewportWidthPx
    );
    const bodyFillColor = viewportIndicatorLayout ? palette.stripFill : palette.fullViewFill;
    state.bodyFillColor = bodyFillColor;

    const morphologySource =
      args.assembly && args.assembly.chromosomes.length > 0
        ? args.assembly.chromosomes
        : args.chromosome;
    if (state.morphologySource !== morphologySource) {
      state.morphologySource = morphologySource;
      state.morphologySignature = placements
        .map(({ chromosome, globalStartBp }) => {
          return `${chromosome.id}:${chromosome.displayName}:${globalStartBp}:${chromosome.length}:${chromosome.cytobands.length}:${JSON.stringify(chromosome.morphology ?? null)}`;
        })
        .join(',');
    }
    const geometryKey = `${CYTOBAND_VERTICAL_CONTRACT_TOKEN}|${totalLengthBp}|${viewportWidthPx}|${layoutEntry.height}|${args.theme.mode}|${bodyFillColor}|${state.morphologySignature ?? ''}`;
    if (geometryKey !== state.geometryKey) {
      this.clearHover(args.container);
      args.container.hitArea = new Rectangle(0, 0, viewportWidthPx, verticalLayout.labelBottomPx);
      const morphology = paintAssemblyBodies(
        state.bodyGfx,
        state.separatorGfx,
        state.indicator,
        state.hoverIndicator,
        placements,
        totalLengthBp,
        viewportWidthPx,
        bandHeightPx,
        palette,
        bodyFillColor
      );
      state.morphology = morphology.items;
      state.sourceCytobandCount = morphology.sourceCytobandCount;
      state.dividerLineCount = morphology.dividerLineCount;
      state.bodyFillCount = morphology.bodyFillCount;
      this.syncLabels(
        args.container,
        state,
        placements,
        totalLengthBp,
        viewportWidthPx,
        palette,
        themeChanged,
        verticalLayout
      );
      state.geometryKey = geometryKey;
    }
    state.viewportIndicatorLayout = paintViewportIndicator(
      state.indicator,
      viewportBpRange.start,
      viewportBpRange.end,
      totalLengthBp,
      viewportWidthPx,
      bandHeightPx
    );
  }

  private syncLabels(
    container: Container,
    state: CytobandContainerState,
    placements: ReadonlyArray<AssemblyChromosomePlacement>,
    totalLengthBp: number,
    widthPx: number,
    palette: CytobandPalette,
    themeChanged: boolean,
    verticalLayout: CytobandVerticalLayout
  ): void {
    while (state.labelTexts.length < placements.length) {
      const text = new Text({
        text: '',
        style: {
          fontFamily: HEADER_FONT_FAMILY,
          fontSize: HEADER_FONT_SIZE,
          lineHeight: HEADER_LINE_HEIGHT,
          fill: palette.header,
          fontWeight: 'normal',
        },
      });
      text.anchor.set(0.5, 0);
      state.labelTexts.push(text);
      container.addChild(text);
    }

    state.labelLayouts = computeLabelLayouts(
      placements,
      totalLengthBp,
      widthPx,
      verticalLayout.labelsFit
    );
    for (let index = 0; index < placements.length; index += 1) {
      const label = state.labelTexts[index];
      const text = state.labelLayouts[index].text;
      if (label.text !== text) label.text = text;
      if (
        themeChanged ||
        label.style.lineHeight !== HEADER_LINE_HEIGHT ||
        label.style.fontSize !== HEADER_FONT_SIZE
      ) {
        label.style = {
          fontFamily: HEADER_FONT_FAMILY,
          fontSize: HEADER_FONT_SIZE,
          lineHeight: HEADER_LINE_HEIGHT,
          fill: palette.header,
          fontWeight: 'normal',
        };
      }
    }

    for (let i = 0; i < state.labelTexts.length; i++) {
      const label = state.labelTexts[i];
      const layout = state.labelLayouts[i];
      if (!layout?.visible || layout.labelLeftPx === null) {
        label.visible = false;
        continue;
      }
      label.visible = true;
      label.position.set(
        layout.memberLeftPx + (layout.memberRightPx - layout.memberLeftPx) / 2,
        verticalLayout.labelTopPx
      );
    }
  }

  unmount(container: Container): void {
    const state = this.containerState.get(container);
    for (const label of state?.labelTexts ?? []) destroyPixiText(label);
    this.containerState.delete(container);
    container.destroy({ children: true });
  }

  getDiagnostics(container: Container): CytobandTrackDiagnostics | null {
    const state = this.containerState.get(container);
    if (!state || !state.verticalLayout) return null;
    return {
      themeMode: state.themeMode,
      headerColor: state.palette.header,
      stripFillColor: state.bodyFillColor,
      stripOutlineWidthPx: 0,
      viewportIndicatorColor: state.palette.viewportIndicator,
      viewportIndicatorAlpha: state.palette.viewportIndicatorAlpha,
      viewportIndicatorMode: 'silhouette-recolor',
      viewportIndicatorClipHeightPx: state.verticalLayout.bandHeightPx,
      hoverPreviewMode: state.hoverPreviewLayout?.mode ?? null,
      hoverPreviewStartBp: state.hoverPreviewLayout?.startBp ?? null,
      hoverPreviewEndBp: state.hoverPreviewLayout?.endBp ?? null,
      hoverPreviewLeftPx: state.hoverPreviewLayout?.leftPx ?? null,
      hoverPreviewWidthPx: state.hoverPreviewLayout?.widthPx ?? null,
      hoveredChromosomeId: state.hoverPreviewLayout?.chromosomeId ?? null,
      hoverPreviewColor: state.hoverPreviewLayout ? state.palette.hover : null,
      hoverPreviewAlpha: state.hoverPreviewLayout ? state.palette.hoverAlpha : null,
      chromosomeCount: state.morphology.length,
      visibleLabelCount: state.labelLayouts.filter(({ visible }) => visible).length,
      hiddenLabelCount: state.labelLayouts.filter(({ visible }) => !visible).length,
      allocatedHeightPx: state.verticalLayout.allocatedHeightPx,
      labelTopPx: state.verticalLayout.labelTopPx,
      labelBottomPx: state.verticalLayout.labelBottomPx,
      contentBottomPx: state.verticalLayout.contentBottomPx,
      requiredTrackHeightPx: state.verticalLayout.requiredTrackHeightPx,
      overflowPx: state.verticalLayout.overflowPx,
      labelsFit: state.verticalLayout.labelsFit,
      viewportIndicatorGeometryBuildCount: state.indicator.geometryBuildCount,
      viewportStartBp: state.viewportIndicatorLayout?.startBp ?? null,
      viewportEndBp: state.viewportIndicatorLayout?.endBp ?? null,
      viewportIndicatorLeftPx: state.viewportIndicatorLayout?.leftPx ?? null,
      viewportIndicatorWidthPx: state.viewportIndicatorLayout?.widthPx ?? null,
      silhouetteChromosomeCount: state.morphology.filter(
        ({ kind }) => kind === 'chromosome-silhouette'
      ).length,
      genericContigCount: state.morphology.filter(({ kind }) => kind === 'generic-contig').length,
      sourceCytobandCount: state.sourceCytobandCount,
      legacyCytobandFillCount: 0,
      bodyFillCount: state.bodyFillCount,
      dividerLineCount: state.dividerLineCount,
      morphology: state.morphology,
      labelLayouts: state.labelLayouts,
    };
  }
}

function paintAssemblyBodies(
  bodyGfx: Graphics,
  separatorGfx: Graphics,
  indicator: ViewportIndicatorState,
  hoverIndicator: ViewportIndicatorState,
  placements: ReadonlyArray<AssemblyChromosomePlacement>,
  totalLengthBp: number,
  widthPx: number,
  heightPx: number,
  palette: CytobandPalette,
  bodyFillColor: string
): {
  items: CytobandMorphologyDiagnostic[];
  sourceCytobandCount: number;
  dividerLineCount: number;
  bodyFillCount: number;
} {
  bodyGfx.clear();
  separatorGfx.clear();
  indicator.highlight.clear();
  hoverIndicator.highlight.clear();
  indicator.geometryBuildCount += 1;
  const items: CytobandMorphologyDiagnostic[] = [];
  let sourceCytobandCount = 0;
  let dividerLineCount = 0;
  let bodyFillCount = 0;
  if (totalLengthBp <= 0) {
    return { items, sourceCytobandCount, dividerLineCount, bodyFillCount };
  }
  const scale = widthPx / totalLengthBp;
  let previousWasGeneric = false;

  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    sourceCytobandCount += placement.chromosome.cytobands.length;
    const leftPx = placement.globalStartBp * scale;
    const memberWidthPx = placement.chromosome.length * scale;
    const rightPx = leftPx + memberWidthPx;

    const morphology = placement.chromosome.morphology;
    const nextPlacement = placements[index + 1];
    if (
      morphology?.kind === 'between-members' &&
      morphology.side === 'right' &&
      nextPlacement?.chromosome.morphology?.kind === 'between-members' &&
      nextPlacement.chromosome.morphology.side === 'left' &&
      nextPlacement.chromosome.morphology.groupId === morphology.groupId
    ) {
      sourceCytobandCount += nextPlacement.chromosome.cytobands.length;
      const rightMemberWidthPx = nextPlacement.chromosome.length * scale;
      const silhouette = computeBetweenMemberSilhouetteGeometry({
        leftPx,
        leftMemberWidthPx: memberWidthPx,
        rightMemberWidthPx,
        heightPx,
      });
      if (silhouette) {
        if (index > 0 && previousWasGeneric) {
          paintSeparator(separatorGfx, leftPx, heightPx, palette);
          dividerLineCount += 1;
        }
        paintSilhouetteSet(bodyGfx, indicator, hoverIndicator, silhouette, palette, bodyFillColor);
        bodyFillCount += 1;
        const groupRightPx = rightPx + rightMemberWidthPx;
        for (const groupedPlacement of [placement, nextPlacement]) {
          items.push({
            chromosomeId: groupedPlacement.chromosome.id,
            kind: 'chromosome-silhouette',
            morphologyKind: 'between-members',
            leftPx: groupedPlacement === placement ? leftPx : nextPlacement.globalStartBp * scale,
            rightPx: groupedPlacement === placement ? rightPx : groupRightPx,
            centromereStartPx: silhouette.centromereStartPx,
            centromereEndPx: silhouette.centromereEndPx,
          });
        }
        previousWasGeneric = false;
        index += 1;
        continue;
      }
    }

    const silhouette =
      morphology?.kind === 'localized'
        ? computeChromosomeSilhouetteGeometry({
            leftPx,
            widthPx: memberWidthPx,
            heightPx,
            chromosomeLengthBp: placement.chromosome.length,
            centromere: morphology.interval,
            topology: morphology.topology,
          })
        : morphology?.kind === 'localized-boundary'
          ? computeCentromereBoundarySilhouetteGeometry({
              leftPx,
              widthPx: memberWidthPx,
              heightPx,
              chromosomeLengthBp: placement.chromosome.length,
              positionBp: morphology.positionBp,
              topology: morphology.topology,
            })
          : morphology?.kind === 'schematic'
            ? computeSchematicChromosomeSilhouetteGeometry({
                leftPx,
                widthPx: memberWidthPx,
                heightPx,
                centromereClass: morphology.centromereClass,
                shortArmAt: morphology.shortArmAt,
              })
            : null;
    const capsule =
      morphology?.kind === 'holocentric' || morphology?.kind === 'unlocalized-centromere'
        ? computeCapsuleSilhouetteGeometry({ leftPx, widthPx: memberWidthPx, heightPx })
        : null;
    const isGeneric = silhouette === null && capsule === null;

    if (index > 0 && (previousWasGeneric || isGeneric)) {
      paintSeparator(separatorGfx, leftPx, heightPx, palette);
      dividerLineCount += 1;
    }

    if (silhouette) {
      paintSilhouetteSet(bodyGfx, indicator, hoverIndicator, silhouette, palette, bodyFillColor);
      bodyFillCount += 1;
      items.push({
        chromosomeId: placement.chromosome.id,
        kind: 'chromosome-silhouette',
        morphologyKind:
          morphology?.kind === 'schematic'
            ? 'schematic'
            : morphology?.kind === 'localized-boundary'
              ? 'localized-boundary'
              : 'localized',
        leftPx,
        rightPx,
        centromereStartPx: silhouette.centromereStartPx,
        centromereEndPx: silhouette.centromereEndPx,
      });
    } else if (capsule) {
      paintCapsuleSet(bodyGfx, indicator, hoverIndicator, capsule, palette, bodyFillColor);
      bodyFillCount += 1;
      items.push({
        chromosomeId: placement.chromosome.id,
        kind: 'chromosome-silhouette',
        morphologyKind:
          morphology?.kind === 'unlocalized-centromere' ? 'unlocalized-centromere' : 'holocentric',
        leftPx,
        rightPx,
      });
    } else {
      bodyGfx.rect(leftPx, 0, memberWidthPx, heightPx).fill({ color: bodyFillColor });
      indicator.highlight
        .rect(leftPx, 0, memberWidthPx, heightPx)
        .fill({ color: palette.viewportIndicator });
      hoverIndicator.highlight.rect(leftPx, 0, memberWidthPx, heightPx).fill({ color: 0xffffff });
      items.push({
        chromosomeId: placement.chromosome.id,
        kind: 'generic-contig',
        leftPx,
        rightPx,
      });
      bodyFillCount += 1;
    }
    previousWasGeneric = isGeneric;
  }
  return { items, sourceCytobandCount, dividerLineCount, bodyFillCount };
}

function paintSeparator(
  separatorGfx: Graphics,
  boundaryPx: number,
  heightPx: number,
  palette: CytobandPalette
): void {
  separatorGfx
    .rect(
      boundaryPx - GENERIC_CONTIG_SEPARATOR_WIDTH_PX / 2,
      0,
      GENERIC_CONTIG_SEPARATOR_WIDTH_PX,
      heightPx
    )
    .fill({ color: palette.separator });
}

function paintSilhouetteSet(
  bodyGfx: Graphics,
  indicator: ViewportIndicatorState,
  hoverIndicator: ViewportIndicatorState,
  silhouette: ChromosomeSilhouetteGeometry,
  palette: CytobandPalette,
  bodyFillColor: string
): void {
  paintSilhouettePath(bodyGfx, silhouette).fill({ color: bodyFillColor });
  paintSilhouettePath(indicator.highlight, silhouette).fill({ color: palette.viewportIndicator });
  paintSilhouettePath(hoverIndicator.highlight, silhouette).fill({ color: 0xffffff });
}

function paintCapsuleSet(
  bodyGfx: Graphics,
  indicator: ViewportIndicatorState,
  hoverIndicator: ViewportIndicatorState,
  capsule: CapsuleSilhouetteGeometry,
  palette: CytobandPalette,
  bodyFillColor: string
): void {
  paintCapsulePath(bodyGfx, capsule).fill({ color: bodyFillColor });
  paintCapsulePath(indicator.highlight, capsule).fill({ color: palette.viewportIndicator });
  paintCapsulePath(hoverIndicator.highlight, capsule).fill({ color: 0xffffff });
}

function paintSilhouettePath(gfx: Graphics, geometry: ChromosomeSilhouetteGeometry): Graphics {
  if (geometry.topology === 'terminal-start') {
    return paintTerminalStartSilhouettePath(gfx, geometry);
  }
  if (geometry.topology === 'terminal-end') {
    return paintTerminalEndSilhouettePath(gfx, geometry);
  }
  const {
    leftPx,
    rightPx,
    topPx,
    bottomPx,
    centerYPx,
    centromereMidpointPx,
    pTelomereRadiusPx,
    qTelomereRadiusPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
    pTaperStartPx,
    qTaperEndPx,
    waistTopPx,
    waistBottomPx,
  } = geometry;
  const verticalKappaPx = ((bottomPx - topPx) / 2) * CIRCLE_BEZIER_KAPPA;

  gfx
    .moveTo(leftPx + pTelomereRadiusPx, topPx)
    .lineTo(pTaperStartPx, topPx)
    .bezierCurveTo(
      pTaperStartPx + pCentromereCurveReachPx * CENTROMERE_OUTER_CONTROL_RATIO,
      topPx,
      centromereMidpointPx - pCentromereCurveReachPx * CENTROMERE_INNER_CONTROL_RATIO,
      waistTopPx,
      centromereMidpointPx,
      waistTopPx
    )
    .bezierCurveTo(
      centromereMidpointPx + qCentromereCurveReachPx * CENTROMERE_INNER_CONTROL_RATIO,
      waistTopPx,
      qTaperEndPx - qCentromereCurveReachPx * CENTROMERE_OUTER_CONTROL_RATIO,
      topPx,
      qTaperEndPx,
      topPx
    )
    .lineTo(rightPx - qTelomereRadiusPx, topPx)
    .bezierCurveTo(
      rightPx - qTelomereRadiusPx + qTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      topPx,
      rightPx,
      centerYPx - verticalKappaPx,
      rightPx,
      centerYPx
    )
    .bezierCurveTo(
      rightPx,
      centerYPx + verticalKappaPx,
      rightPx - qTelomereRadiusPx + qTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      bottomPx,
      rightPx - qTelomereRadiusPx,
      bottomPx
    )
    .lineTo(qTaperEndPx, bottomPx)
    .bezierCurveTo(
      qTaperEndPx - qCentromereCurveReachPx * CENTROMERE_OUTER_CONTROL_RATIO,
      bottomPx,
      centromereMidpointPx + qCentromereCurveReachPx * CENTROMERE_INNER_CONTROL_RATIO,
      waistBottomPx,
      centromereMidpointPx,
      waistBottomPx
    )
    .bezierCurveTo(
      centromereMidpointPx - pCentromereCurveReachPx * CENTROMERE_INNER_CONTROL_RATIO,
      waistBottomPx,
      pTaperStartPx + pCentromereCurveReachPx * CENTROMERE_OUTER_CONTROL_RATIO,
      bottomPx,
      pTaperStartPx,
      bottomPx
    )
    .lineTo(leftPx + pTelomereRadiusPx, bottomPx)
    .bezierCurveTo(
      leftPx + pTelomereRadiusPx - pTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      bottomPx,
      leftPx,
      centerYPx + verticalKappaPx,
      leftPx,
      centerYPx
    )
    .bezierCurveTo(
      leftPx,
      centerYPx - verticalKappaPx,
      leftPx + pTelomereRadiusPx - pTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      topPx,
      leftPx + pTelomereRadiusPx,
      topPx
    )
    .closePath();
  return gfx;
}

function paintTerminalStartSilhouettePath(
  gfx: Graphics,
  geometry: ChromosomeSilhouetteGeometry
): Graphics {
  const {
    leftPx,
    rightPx,
    topPx,
    bottomPx,
    centerYPx,
    qTelomereRadiusPx,
    qTaperEndPx,
    terminalCap,
  } = geometry;
  if (!terminalCap) {
    return paintCapsulePath(gfx, {
      leftPx,
      rightPx,
      topPx,
      bottomPx,
      centerYPx,
      radiusPx: Math.min((bottomPx - topPx) / 2, (rightPx - leftPx) / 2),
    });
  }
  const distalVerticalKappaPx = ((bottomPx - topPx) / 2) * CIRCLE_BEZIER_KAPPA;
  const upperTowardBody = unitVector(
    qTaperEndPx - terminalCap.upperTangentXPx,
    topPx - terminalCap.upperTangentYPx
  );
  const lowerTowardBody = unitVector(
    qTaperEndPx - terminalCap.lowerTangentXPx,
    bottomPx - terminalCap.lowerTangentYPx
  );

  gfx
    .moveTo(terminalCap.upperTangentXPx, terminalCap.upperTangentYPx)
    .bezierCurveTo(
      terminalCap.upperTangentXPx + upperTowardBody.x * terminalCap.arcControlReachPx,
      terminalCap.upperTangentYPx + upperTowardBody.y * terminalCap.arcControlReachPx,
      qTaperEndPx + (terminalCap.upperTangentXPx - qTaperEndPx) * CENTROMERE_OUTER_CONTROL_RATIO,
      topPx,
      qTaperEndPx,
      topPx
    )
    .lineTo(rightPx - qTelomereRadiusPx, topPx)
    .bezierCurveTo(
      rightPx - qTelomereRadiusPx + qTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      topPx,
      rightPx,
      centerYPx - distalVerticalKappaPx,
      rightPx,
      centerYPx
    )
    .bezierCurveTo(
      rightPx,
      centerYPx + distalVerticalKappaPx,
      rightPx - qTelomereRadiusPx + qTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      bottomPx,
      rightPx - qTelomereRadiusPx,
      bottomPx
    )
    .lineTo(qTaperEndPx, bottomPx)
    .bezierCurveTo(
      qTaperEndPx + (terminalCap.lowerTangentXPx - qTaperEndPx) * CENTROMERE_OUTER_CONTROL_RATIO,
      bottomPx,
      terminalCap.lowerTangentXPx + lowerTowardBody.x * terminalCap.arcControlReachPx,
      terminalCap.lowerTangentYPx + lowerTowardBody.y * terminalCap.arcControlReachPx,
      terminalCap.lowerTangentXPx,
      terminalCap.lowerTangentYPx
    );
  paintTerminalCapArc(
    gfx,
    terminalCap,
    {
      x: terminalCap.lowerTangentXPx,
      y: terminalCap.lowerTangentYPx,
    },
    {
      x: terminalCap.tipXPx,
      y: terminalCap.centerYPx,
    }
  );
  paintTerminalCapArc(
    gfx,
    terminalCap,
    {
      x: terminalCap.tipXPx,
      y: terminalCap.centerYPx,
    },
    {
      x: terminalCap.upperTangentXPx,
      y: terminalCap.upperTangentYPx,
    }
  );
  gfx.closePath();
  return gfx;
}

function paintTerminalEndSilhouettePath(
  gfx: Graphics,
  geometry: ChromosomeSilhouetteGeometry
): Graphics {
  const {
    leftPx,
    rightPx,
    topPx,
    bottomPx,
    centerYPx,
    pTelomereRadiusPx,
    pTaperStartPx,
    terminalCap,
  } = geometry;
  if (!terminalCap) {
    return paintCapsulePath(gfx, {
      leftPx,
      rightPx,
      topPx,
      bottomPx,
      centerYPx,
      radiusPx: Math.min((bottomPx - topPx) / 2, (rightPx - leftPx) / 2),
    });
  }
  const distalVerticalKappaPx = ((bottomPx - topPx) / 2) * CIRCLE_BEZIER_KAPPA;
  const upperTowardBody = unitVector(
    pTaperStartPx - terminalCap.upperTangentXPx,
    topPx - terminalCap.upperTangentYPx
  );
  const lowerTowardBody = unitVector(
    pTaperStartPx - terminalCap.lowerTangentXPx,
    bottomPx - terminalCap.lowerTangentYPx
  );

  gfx
    .moveTo(leftPx + pTelomereRadiusPx, topPx)
    .lineTo(pTaperStartPx, topPx)
    .bezierCurveTo(
      pTaperStartPx +
        (terminalCap.upperTangentXPx - pTaperStartPx) * CENTROMERE_OUTER_CONTROL_RATIO,
      topPx,
      terminalCap.upperTangentXPx + upperTowardBody.x * terminalCap.arcControlReachPx,
      terminalCap.upperTangentYPx + upperTowardBody.y * terminalCap.arcControlReachPx,
      terminalCap.upperTangentXPx,
      terminalCap.upperTangentYPx
    );
  paintTerminalCapArc(
    gfx,
    terminalCap,
    {
      x: terminalCap.upperTangentXPx,
      y: terminalCap.upperTangentYPx,
    },
    {
      x: terminalCap.tipXPx,
      y: terminalCap.centerYPx,
    }
  );
  paintTerminalCapArc(
    gfx,
    terminalCap,
    {
      x: terminalCap.tipXPx,
      y: terminalCap.centerYPx,
    },
    {
      x: terminalCap.lowerTangentXPx,
      y: terminalCap.lowerTangentYPx,
    }
  );
  gfx
    .bezierCurveTo(
      terminalCap.lowerTangentXPx + lowerTowardBody.x * terminalCap.arcControlReachPx,
      terminalCap.lowerTangentYPx + lowerTowardBody.y * terminalCap.arcControlReachPx,
      pTaperStartPx +
        (terminalCap.lowerTangentXPx - pTaperStartPx) * CENTROMERE_OUTER_CONTROL_RATIO,
      bottomPx,
      pTaperStartPx,
      bottomPx
    )
    .lineTo(leftPx + pTelomereRadiusPx, bottomPx)
    .bezierCurveTo(
      leftPx + pTelomereRadiusPx - pTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      bottomPx,
      leftPx,
      centerYPx + distalVerticalKappaPx,
      leftPx,
      centerYPx
    )
    .bezierCurveTo(
      leftPx,
      centerYPx - distalVerticalKappaPx,
      leftPx + pTelomereRadiusPx - pTelomereRadiusPx * CIRCLE_BEZIER_KAPPA,
      topPx,
      leftPx + pTelomereRadiusPx,
      topPx
    )
    .closePath();
  return gfx;
}

function paintTerminalCapArc(
  gfx: Graphics,
  cap: TerminalCentromereCapGeometry,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number }
): Graphics {
  const startRadial = {
    x: (start.x - cap.centerXPx) / cap.radiusPx,
    y: (start.y - cap.centerYPx) / cap.radiusPx,
  };
  const endRadial = {
    x: (end.x - cap.centerXPx) / cap.radiusPx,
    y: (end.y - cap.centerYPx) / cap.radiusPx,
  };
  const startTangent = { x: -startRadial.y, y: startRadial.x };
  const endTangent = { x: -endRadial.y, y: endRadial.x };
  return gfx.bezierCurveTo(
    start.x + startTangent.x * cap.arcControlReachPx,
    start.y + startTangent.y * cap.arcControlReachPx,
    end.x - endTangent.x * cap.arcControlReachPx,
    end.y - endTangent.y * cap.arcControlReachPx,
    end.x,
    end.y
  );
}

function unitVector(x: number, y: number): { readonly x: number; readonly y: number } {
  const length = Math.hypot(x, y);
  return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
}

function paintCapsulePath(gfx: Graphics, geometry: CapsuleSilhouetteGeometry): Graphics {
  const { leftPx, rightPx, topPx, bottomPx, centerYPx, radiusPx } = geometry;
  const horizontalKappaPx = radiusPx * CIRCLE_BEZIER_KAPPA;
  const verticalKappaPx = ((bottomPx - topPx) / 2) * CIRCLE_BEZIER_KAPPA;
  return gfx
    .moveTo(leftPx + radiusPx, topPx)
    .lineTo(rightPx - radiusPx, topPx)
    .bezierCurveTo(
      rightPx - radiusPx + horizontalKappaPx,
      topPx,
      rightPx,
      centerYPx - verticalKappaPx,
      rightPx,
      centerYPx
    )
    .bezierCurveTo(
      rightPx,
      centerYPx + verticalKappaPx,
      rightPx - radiusPx + horizontalKappaPx,
      bottomPx,
      rightPx - radiusPx,
      bottomPx
    )
    .lineTo(leftPx + radiusPx, bottomPx)
    .bezierCurveTo(
      leftPx + radiusPx - horizontalKappaPx,
      bottomPx,
      leftPx,
      centerYPx + verticalKappaPx,
      leftPx,
      centerYPx
    )
    .bezierCurveTo(
      leftPx,
      centerYPx - verticalKappaPx,
      leftPx + radiusPx - horizontalKappaPx,
      topPx,
      leftPx + radiusPx,
      topPx
    )
    .closePath();
}

function computeLabelLayouts(
  placements: ReadonlyArray<AssemblyChromosomePlacement>,
  totalLengthBp: number,
  widthPx: number,
  labelsFit: boolean
): CytobandLabelLayout[] {
  const scale = totalLengthBp > 0 ? widthPx / totalLengthBp : 0;
  return layoutCytobandLabels(
    placements.map((placement) => {
      const text = compactCytobandLabel(placement.chromosome.displayName);
      return {
        chromosomeId: placement.chromosome.id,
        text,
        textWidthPx: estimateCytobandLabelWidthPx(text),
        leftPx: placement.globalStartBp * scale,
        rightPx: placement.globalEndBp * scale,
      };
    })
  ).map((layout) =>
    labelsFit ? layout : { ...layout, visible: false, labelLeftPx: null, labelRightPx: null }
  );
}

function findLabelTarget(
  placements: ReadonlyArray<AssemblyChromosomePlacement>,
  layouts: ReadonlyArray<CytobandLabelLayout>,
  localX: number
): { labelIndex: number; placement: AssemblyChromosomePlacement } | null {
  const labelIndex = findCytobandLabelIndexAtX(layouts, localX, LABEL_HIT_PADDING_X_PX);
  const placement = placements[labelIndex];
  return placement ? { labelIndex, placement } : null;
}

function centerRangeWithinBounds(centerBp: number, spanBp: number, totalLengthBp: number): BpRange {
  if (spanBp >= totalLengthBp) return { start: 0, end: totalLengthBp };
  const start = Math.max(0, Math.min(totalLengthBp - spanBp, centerBp - spanBp / 2));
  return { start, end: start + spanBp };
}

function setHoveredLabel(state: CytobandContainerState, labelIndex: number | null): void {
  if (state.hoveredLabelIndex === labelIndex) return;
  const previous =
    state.hoveredLabelIndex === null ? null : state.labelTexts[state.hoveredLabelIndex];
  if (previous) {
    previous.style.fill = state.palette.header;
    previous.style.fontWeight = 'normal';
  }
  state.hoveredLabelIndex = labelIndex;
  const next = labelIndex === null ? null : state.labelTexts[labelIndex];
  if (next) {
    next.style.fill = state.palette.labelHoverText;
    next.style.fontWeight = '700';
  }
}

function createViewportIndicator(): ViewportIndicatorState {
  const root = new Container();
  root.eventMode = 'none';
  const highlight = new Graphics();
  const clip = new Graphics().rect(0, 0, 1, 1).fill({ color: 0xffffff });
  for (const part of [highlight, clip]) {
    part.eventMode = 'none';
    root.addChild(part);
  }
  highlight.mask = clip;
  return {
    root,
    highlight,
    clip,
    geometryBuildCount: 0,
  };
}

function paintViewportIndicator(
  indicator: ViewportIndicatorState,
  viewStartBp: number,
  viewEndBp: number,
  totalLengthBp: number,
  widthPx: number,
  heightPx: number
): ViewportIndicatorLayout | null {
  const layout = resolveViewportIndicatorLayout(viewStartBp, viewEndBp, totalLengthBp, widthPx);
  if (!layout) {
    indicator.root.visible = false;
    return null;
  }
  indicator.root.visible = true;
  placeIndicatorPart(indicator.clip, layout.leftPx, 0, layout.widthPx, heightPx);
  return layout;
}

export function resolveViewportIndicatorLayout(
  viewStartBp: number,
  viewEndBp: number,
  totalLengthBp: number,
  widthPx: number
): ViewportIndicatorLayout | null {
  if (
    totalLengthBp <= 0 ||
    widthPx <= 0 ||
    !Number.isFinite(viewStartBp) ||
    !Number.isFinite(viewEndBp) ||
    !Number.isFinite(totalLengthBp) ||
    !Number.isFinite(widthPx)
  ) {
    return null;
  }
  const clampedStart = Math.max(0, viewStartBp);
  const clampedEnd = Math.min(totalLengthBp, viewEndBp);
  if (clampedEnd <= clampedStart) return null;

  const scale = widthPx / totalLengthBp;
  const x0 = clampedStart * scale;
  const x1 = clampedEnd * scale;
  if (x0 <= FULL_VIEW_EDGE_EPSILON_PX && widthPx - x1 <= FULL_VIEW_EDGE_EPSILON_PX) {
    return null;
  }
  const indicatorWidthPx = Math.max(VIEWPORT_INDICATOR_MIN_WIDTH_PX, x1 - x0);
  return {
    startBp: clampedStart,
    endBp: clampedEnd,
    leftPx: Math.min(x0, Math.max(0, widthPx - indicatorWidthPx)),
    widthPx: indicatorWidthPx,
  };
}

function placeIndicatorPart(
  part: Graphics,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  part.position.set(x, y);
  part.scale.set(width, height);
  part.visible = width > 0 && height > 0;
}
