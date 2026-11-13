import { normalizeStructureScoreColor, normalizeStructureViewScores } from './structureScoreState';
import type {
  AdvancedViewerSettings,
  Structure3dAttrs,
  Structure3dRepresentation,
  StructureSideChainVisualizationState,
  StructureTargetSelector,
  StructureViewState,
  StructureVisualColorMode,
  ViewRecipe,
} from '../types';
import {
  attrsPatchFromStructureViewState,
  createDefaultStructureViewState,
  createStructureViewStateFromRecipe,
  structureViewStateFromAttrs,
  viewWithCanvasSettings,
  viewWithGlobalColorMode,
} from './viewRecipe';
import {
  clearVisualLayerOverrides,
  setVisualLayerAlpha,
  setVisualLayerColor,
  setVisualLayerRepresentation,
  setVisualLayerTarget,
  setVisualLayerVisibility,
} from './viewLayerOverrides';
import {
  setDetailChainInstanceVisibility,
  setDetailMemberVisibility,
} from './structureDetailState';

export type StructureViewCommand =
  | { type: 'select-recipe'; recipe: ViewRecipe }
  | { type: 'set-global-color-mode'; colorMode: StructureVisualColorMode }
  | { type: 'set-show-water'; visible: boolean }
  | { type: 'set-spin'; enabled: boolean }
  | { type: 'set-canvas-settings'; settings: Partial<AdvancedViewerSettings> }
  | { type: 'set-layer-visible'; layerId: string; visible: boolean }
  | {
      type: 'set-layer-representation';
      layerId: string;
      representation: Structure3dRepresentation;
    }
  | { type: 'set-layer-target'; layerId: string; target: StructureTargetSelector }
  | { type: 'set-layer-color'; layerId: string; colorMode: StructureVisualColorMode }
  | { type: 'set-layer-alpha'; layerId: string; alpha: number }
  | { type: 'reset-layer-overrides' }
  | { type: 'set-detail-member-visible'; memberId: string; visible: boolean }
  | {
      type: 'set-detail-chain-visible';
      chainInstanceId: string;
      visible: boolean;
      fallbackDetailChainInstanceIds?: readonly string[];
    }
  | { type: 'set-chain-visible'; chainInstanceId: string; visible: boolean }
  | {
      type: 'set-side-chain-visibility';
      target: keyof StructureSideChainVisualizationState;
      visible: boolean;
    };

export function clearStructureChainVisibilityMask(view: StructureViewState): StructureViewState {
  return view.hiddenChainInstanceIds?.length ? { ...view, hiddenChainInstanceIds: [] } : view;
}

export function reduceStructureViewCommand(
  input: Parameters<typeof reduceStructureViewCommandRaw>[0]
): StructureViewState | null {
  const view = reduceStructureViewCommandRaw(input);
  return view && input.attrs ? normalizeStructureViewScores(view, input.attrs) : view;
}

function reduceStructureViewCommandRaw(input: {
  attrs?: Structure3dAttrs;
  command: StructureViewCommand;
}): StructureViewState | null {
  const attrs = input.attrs;
  if (!attrs) return reduceStructureViewCommandWithoutAttrs(input.command);
  const baseView = viewWithCurrentCamera(canonicalViewForAttrs(attrs), attrs);

  switch (input.command.type) {
    case 'select-recipe':
      return {
        ...createStructureViewStateFromRecipe(input.command.recipe, {
          cameraSnapshot: attrs.cameraSnapshot,
          showWater: baseView.showWater,
          spin: baseView.spin,
          backgroundColor: attrs.backgroundColor,
        }),
        ...(baseView.renderIntent ? { renderIntent: baseView.renderIntent } : {}),
        ...(baseView.detailMemberIds !== undefined
          ? { detailMemberIds: [...baseView.detailMemberIds] }
          : {}),
        ...(baseView.detailChainInstanceIds !== undefined
          ? { detailChainInstanceIds: [...baseView.detailChainInstanceIds] }
          : {}),
        ...(baseView.hiddenChainInstanceIds !== undefined
          ? { hiddenChainInstanceIds: [...baseView.hiddenChainInstanceIds] }
          : {}),
        ...(baseView.residueVisualization
          ? { residueVisualization: cloneResidueVisualization(baseView.residueVisualization) }
          : {}),
      };
    case 'set-global-color-mode':
      return viewWithGlobalColorMode(
        baseView,
        input.command.colorMode === 'bfactor'
          ? normalizeStructureScoreColor('bfactor', attrs)
          : input.command.colorMode
      );
    case 'set-show-water':
      return { ...baseView, showWater: input.command.visible };
    case 'set-spin':
      return { ...baseView, spin: input.command.enabled };
    case 'set-canvas-settings':
      return viewWithCanvasSettings(baseView, input.command.settings);
    case 'set-layer-visible':
      return setVisualLayerVisibility(baseView, input.command.layerId, input.command.visible);
    case 'set-layer-representation':
      return setVisualLayerRepresentation(
        baseView,
        input.command.layerId,
        input.command.representation
      );
    case 'set-layer-target':
      return setVisualLayerTarget(baseView, input.command.layerId, input.command.target);
    case 'set-layer-color':
      return setVisualLayerColor(
        baseView,
        input.command.layerId,
        input.command.colorMode === 'bfactor'
          ? normalizeStructureScoreColor('bfactor', attrs)
          : input.command.colorMode
      );
    case 'set-layer-alpha':
      return setVisualLayerAlpha(baseView, input.command.layerId, input.command.alpha);
    case 'reset-layer-overrides':
      return clearVisualLayerOverrides(baseView);
    case 'set-detail-member-visible':
      return setDetailMemberVisibility(
        baseView,
        attrs.scene,
        input.command.memberId,
        input.command.visible
      );
    case 'set-detail-chain-visible':
      return setDetailChainInstanceVisibility(
        baseView,
        input.command.chainInstanceId,
        input.command.visible,
        input.command.fallbackDetailChainInstanceIds ?? []
      );
    case 'set-chain-visible': {
      const hidden = new Set(baseView.hiddenChainInstanceIds ?? []);
      if (input.command.visible) hidden.delete(input.command.chainInstanceId);
      else hidden.add(input.command.chainInstanceId);
      return { ...baseView, hiddenChainInstanceIds: [...hidden] };
    }
    case 'set-side-chain-visibility':
      return viewWithSideChainVisibility(baseView, input.command.target, input.command.visible);
  }
}

function reduceStructureViewCommandWithoutAttrs(
  command: StructureViewCommand
): StructureViewState | null {
  const baseView = createDefaultStructureViewState();
  switch (command.type) {
    case 'select-recipe':
      return createStructureViewStateFromRecipe(command.recipe);
    case 'set-global-color-mode':
      return viewWithGlobalColorMode(baseView, command.colorMode);
    case 'set-show-water':
      return { ...baseView, showWater: command.visible };
    case 'set-spin':
      return { ...baseView, spin: command.enabled };
    case 'set-canvas-settings':
      return viewWithCanvasSettings(baseView, command.settings);
    case 'set-layer-visible':
      return setVisualLayerVisibility(baseView, command.layerId, command.visible);
    case 'set-layer-representation':
      return setVisualLayerRepresentation(baseView, command.layerId, command.representation);
    case 'set-layer-target':
      return setVisualLayerTarget(baseView, command.layerId, command.target);
    case 'set-layer-color':
      return setVisualLayerColor(baseView, command.layerId, command.colorMode);
    case 'set-layer-alpha':
      return setVisualLayerAlpha(baseView, command.layerId, command.alpha);
    case 'reset-layer-overrides':
      return clearVisualLayerOverrides(baseView);
    case 'set-detail-member-visible':
    case 'set-detail-chain-visible':
    case 'set-chain-visible':
      return null;
    case 'set-side-chain-visibility':
      return viewWithSideChainVisibility(baseView, command.target, command.visible);
  }
}

export function attrsPatchFromStructureViewCommand(input: {
  attrs?: Structure3dAttrs;
  command: StructureViewCommand;
}): Partial<Structure3dAttrs> | null {
  const view = reduceStructureViewCommand(input);
  if (!view) return null;
  return attrsPatchFromStructureViewState(view);
}

function canonicalViewForAttrs(attrs: Structure3dAttrs): StructureViewState {
  return structureViewStateFromAttrs(attrs);
}

function viewWithCurrentCamera(
  view: StructureViewState,
  attrs: Structure3dAttrs
): StructureViewState {
  if (view.cameraSnapshot !== undefined || attrs.cameraSnapshot === undefined) return view;
  return { ...view, cameraSnapshot: attrs.cameraSnapshot };
}

function viewWithSideChainVisibility(
  view: StructureViewState,
  target: keyof StructureSideChainVisualizationState,
  visible: boolean
): StructureViewState {
  return {
    ...view,
    residueVisualization: {
      ...view.residueVisualization,
      sideChains: {
        ...view.residueVisualization?.sideChains,
        [target]: visible,
      },
    },
  };
}

function cloneResidueVisualization(
  residueVisualization: NonNullable<StructureViewState['residueVisualization']>
): NonNullable<StructureViewState['residueVisualization']> {
  return {
    ...residueVisualization,
    ...(residueVisualization.sideChains
      ? { sideChains: { ...residueVisualization.sideChains } }
      : {}),
  };
}
