'use client';

import { useCallback, useEffect, useRef } from 'react';
import type {
  Structure3dAttrs,
  Structure3dRepresentation,
  Structure3dColorMode,
  StructureVisualColorMode,
  StructureTargetSelector,
  AdvancedViewerSettings,
  ViewRecipe,
} from '../types';
import {
  attrsPatchFromStructureViewCommand,
  type StructureViewCommand,
} from '../utils/structureViewCommands';

interface UseViewerSettingsProps {
  attrs?: Structure3dAttrs;
  getLatestAttrs?: () => Structure3dAttrs | undefined;
  updateAttrs: (updates: Partial<Structure3dAttrs>) => void;
}

interface UseViewerSettingsReturn {
  handleSelectRecipe: (recipe: ViewRecipe) => void;
  handleColorModeChange: (value: Structure3dColorMode) => void;
  handleShowWaterChange: (value: boolean) => void;
  handleSpinChange: (value: boolean) => void;
  handleAdvancedSettingsChange: (settings: Partial<AdvancedViewerSettings>) => void;
  handleToggleLayerVisibility: (layerId: string, visible: boolean) => void;
  handleLayerRepresentationChange: (
    layerId: string,
    representation: Structure3dRepresentation
  ) => void;
  handleLayerTargetChange: (layerId: string, target: StructureTargetSelector) => void;
  handleLayerColorChange: (layerId: string, colorMode: StructureVisualColorMode) => void;
  handleLayerAlphaChange: (layerId: string, alpha: number) => void;
  handleResetLayerOverrides: () => void;
  handleToggleDetailMember: (memberId: string, visible: boolean) => void;
  handleToggleDetailChain: (
    chainInstanceId: string,
    visible: boolean,
    currentVisibleChainInstanceIds: readonly string[]
  ) => void;
  handleToggleChainVisibility: (chainInstanceId: string, visible: boolean) => void;
  handleVisibleBackboneSideChainsChange: (visible: boolean) => void;
  handleSelectionSideChainsChange: (visible: boolean) => void;
}

export function useViewerSettings({
  attrs,
  getLatestAttrs,
  updateAttrs,
}: UseViewerSettingsProps): UseViewerSettingsReturn {
  const pendingAttrsRef = useRef<Structure3dAttrs | undefined>(undefined);
  useEffect(() => {
    pendingAttrsRef.current = undefined;
  }, [attrs]);

  const latestAttrs = useCallback(
    () => pendingAttrsRef.current ?? getLatestAttrs?.() ?? attrs,
    [attrs, getLatestAttrs]
  );

  const applyStructureViewCommand = useCallback(
    (command: StructureViewCommand) => {
      const currentAttrs = latestAttrs();
      const updates = attrsPatchFromStructureViewCommand({ attrs: currentAttrs, command });
      if (!updates) return;
      pendingAttrsRef.current = currentAttrs ? { ...currentAttrs, ...updates } : undefined;
      updateAttrs(updates);
    },
    [latestAttrs, updateAttrs]
  );

  const handleSelectRecipe = useCallback(
    (recipe: ViewRecipe) => {
      applyStructureViewCommand({ type: 'select-recipe', recipe });
    },
    [applyStructureViewCommand]
  );

  const handleColorModeChange = useCallback(
    (value: Structure3dColorMode) => {
      applyStructureViewCommand({ type: 'set-global-color-mode', colorMode: value });
    },
    [applyStructureViewCommand]
  );

  const handleShowWaterChange = useCallback(
    (value: boolean) => {
      applyStructureViewCommand({ type: 'set-show-water', visible: value });
    },
    [applyStructureViewCommand]
  );

  const handleSpinChange = useCallback(
    (value: boolean) => {
      applyStructureViewCommand({ type: 'set-spin', enabled: value });
    },
    [applyStructureViewCommand]
  );

  const handleAdvancedSettingsChange = useCallback(
    (settings: Partial<AdvancedViewerSettings>) => {
      applyStructureViewCommand({ type: 'set-canvas-settings', settings });
    },
    [applyStructureViewCommand]
  );

  const handleToggleLayerVisibility = useCallback(
    (layerId: string, visible: boolean) => {
      applyStructureViewCommand({ type: 'set-layer-visible', layerId, visible });
    },
    [applyStructureViewCommand]
  );

  const handleLayerRepresentationChange = useCallback(
    (layerId: string, representation: Structure3dRepresentation) => {
      applyStructureViewCommand({
        type: 'set-layer-representation',
        layerId,
        representation,
      });
    },
    [applyStructureViewCommand]
  );

  const handleLayerTargetChange = useCallback(
    (layerId: string, target: StructureTargetSelector) => {
      applyStructureViewCommand({ type: 'set-layer-target', layerId, target });
    },
    [applyStructureViewCommand]
  );

  const handleLayerColorChange = useCallback(
    (layerId: string, colorMode: StructureVisualColorMode) => {
      applyStructureViewCommand({ type: 'set-layer-color', layerId, colorMode });
    },
    [applyStructureViewCommand]
  );

  const handleLayerAlphaChange = useCallback(
    (layerId: string, alpha: number) => {
      applyStructureViewCommand({ type: 'set-layer-alpha', layerId, alpha });
    },
    [applyStructureViewCommand]
  );

  const handleResetLayerOverrides = useCallback(() => {
    applyStructureViewCommand({ type: 'reset-layer-overrides' });
  }, [applyStructureViewCommand]);

  const handleToggleDetailMember = useCallback(
    (memberId: string, visible: boolean) => {
      applyStructureViewCommand({ type: 'set-detail-member-visible', memberId, visible });
    },
    [applyStructureViewCommand]
  );

  const handleToggleDetailChain = useCallback(
    (
      chainInstanceId: string,
      visible: boolean,
      currentVisibleChainInstanceIds: readonly string[]
    ) => {
      applyStructureViewCommand({
        type: 'set-detail-chain-visible',
        chainInstanceId,
        visible,
        fallbackDetailChainInstanceIds: currentVisibleChainInstanceIds,
      });
    },
    [applyStructureViewCommand]
  );

  const handleToggleChainVisibility = useCallback(
    (chainInstanceId: string, visible: boolean) => {
      applyStructureViewCommand({ type: 'set-chain-visible', chainInstanceId, visible });
    },
    [applyStructureViewCommand]
  );

  const handleVisibleBackboneSideChainsChange = useCallback(
    (visible: boolean) => {
      applyStructureViewCommand({
        type: 'set-side-chain-visibility',
        target: 'visibleBackbones',
        visible,
      });
    },
    [applyStructureViewCommand]
  );

  const handleSelectionSideChainsChange = useCallback(
    (visible: boolean) => {
      applyStructureViewCommand({
        type: 'set-side-chain-visibility',
        target: 'selection',
        visible,
      });
    },
    [applyStructureViewCommand]
  );

  return {
    handleSelectRecipe,
    handleColorModeChange,
    handleShowWaterChange,
    handleSpinChange,
    handleAdvancedSettingsChange,
    handleToggleLayerVisibility,
    handleLayerRepresentationChange,
    handleLayerTargetChange,
    handleLayerColorChange,
    handleLayerAlphaChange,
    handleResetLayerOverrides,
    handleToggleDetailMember,
    handleToggleDetailChain,
    handleToggleChainVisibility,
    handleVisibleBackboneSideChainsChange,
    handleSelectionSideChainsChange,
  };
}
