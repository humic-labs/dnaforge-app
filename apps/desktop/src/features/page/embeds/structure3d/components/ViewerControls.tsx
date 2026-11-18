'use client';

import { MenuNativeSelect } from '@waypoint/ui-components';

import { memo, useState, useRef } from 'react';
import type {
  Structure3dColorMode,
  ViewRecipe,
  HighlightGroup,
  StructureScene,
  StructureComplexMember,
  StructureViewState,
  StructureSideChainVisualizationState,
} from '../types';
import { getColorOptions, type StructureScoreContext } from '../utils/structureScoreState';
import { ViewRecipeDropdown } from './ViewRecipeDropdown';
import { SelectionsDrawer } from './SelectionsDrawer';
import { StructureFocusSelect } from './StructureFocusSelect';
import { visualLayersForView } from '../utils/viewLayerOverrides';

interface ViewerControlsProps {
  colorMode: Structure3dColorMode;
  showWater: boolean;
  spin: boolean;
  source: string | StructureScoreContext;
  layout: 'sidebar' | 'bar';
  activeRecipeId?: string | null;
  viewRecipes?: ViewRecipe[];
  scene?: StructureScene;
  view?: StructureViewState;
  focusableMembers?: StructureComplexMember[];
  highlightGroups?: HighlightGroup[];
  selectionLoadErrors?: ReadonlyArray<string>;
  sideChains?: StructureSideChainVisualizationState;
  onColorModeChange: (value: Structure3dColorMode) => void;
  onShowWaterChange: (value: boolean) => void;
  onSpinChange: (value: boolean) => void;
  onVisibleBackboneSideChainsChange?: (value: boolean) => void;
  onSelectRecipe: (recipe: ViewRecipe) => void;
  onFocusMemberChange?: (memberId: string) => void;
  onActivateHighlight?: (groupId: string) => void;
  onRenameHighlight?: (groupId: string, newLabel: string) => void | Promise<void>;
  onDeleteHighlight?: (groupId: string) => void;
}

export const ViewerControls = memo(function ViewerControls({
  colorMode,
  showWater,
  spin,
  source,
  layout,
  activeRecipeId,
  viewRecipes,
  scene,
  view,
  focusableMembers,
  highlightGroups,
  selectionLoadErrors,
  sideChains,
  onColorModeChange,
  onShowWaterChange,
  onSpinChange,
  onVisibleBackboneSideChainsChange,
  onSelectRecipe,
  onFocusMemberChange,
  onActivateHighlight,
  onRenameHighlight,
  onDeleteHighlight,
}: ViewerControlsProps) {
  const colorOptions = getColorOptions(source);
  const [isSelectionsOpen, setIsSelectionsOpen] = useState(false);
  const selectionsCount = highlightGroups?.length || 0;
  const selectionsContainerRef = useRef<HTMLDivElement>(null);
  const focusMembers = focusableMembers ?? scene?.members ?? [];
  const visualLayers = view ? visualLayersForView(view) : [];
  const showFocusControl =
    focusMembers.length > 1 &&
    !!onFocusMemberChange &&
    visualLayers.some((layer) => layerTargetsActiveFocus(layer.target));
  const activeFocusMemberId = scene?.activeFocus?.memberId ?? scene?.queryAnchor.memberId ?? '';

  if (layout === 'sidebar') {
    return (
      <div className="flex-1 min-w-0 p-2 flex flex-col gap-3 overflow-y-clip">
        <ViewRecipeDropdown
          activeRecipeId={activeRecipeId ?? null}
          activeRecipeNameFallback={view?.recipe.name}
          recipes={viewRecipes ?? []}
          onSelectRecipe={onSelectRecipe}
          layout="sidebar"
        />

        {showFocusControl && (
          <StructureFocusSelect
            members={focusMembers}
            activeMemberId={activeFocusMemberId}
            onFocusMemberChange={onFocusMemberChange}
            layout="sidebar"
          />
        )}

        {}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-fg-muted uppercase tracking-wide">Color</span>
          <MenuNativeSelect
            aria-label="Structure color mode"
            value={colorMode}
            onChange={(e) => onColorModeChange(e.target.value as Structure3dColorMode)}
            data-testid="color-mode-select"
          >
            {colorOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </MenuNativeSelect>
        </div>

        {}
        <div className="flex flex-col gap-1.5 mt-2">
          <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showWater}
              onChange={(e) => onShowWaterChange(e.target.checked)}
              className="w-3 h-3 rounded border-border"
            />
            Water
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={spin}
              onChange={(e) => onSpinChange(e.target.checked)}
              className="w-3 h-3 rounded border-border"
            />
            Spin
          </label>
          {onVisibleBackboneSideChainsChange && (
            <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
              <input
                type="checkbox"
                checked={sideChains?.visibleBackbones === true}
                onChange={(e) => onVisibleBackboneSideChainsChange(e.target.checked)}
                className="w-3 h-3 rounded border-border"
                data-testid="structure-visible-backbone-sidechains-toggle"
              />
              Side chains
            </label>
          )}
        </div>

        {}
        {onActivateHighlight && onRenameHighlight && onDeleteHighlight && (
          <div ref={selectionsContainerRef} className="mt-auto pt-2 border-t border-border">
            <button
              onClick={() => setIsSelectionsOpen(!isSelectionsOpen)}
              className={`w-full text-[10px] px-1.5 py-1 rounded border transition-colors ${
                selectionsCount > 0
                  ? 'border-accent text-accent hover:bg-accent/10'
                  : 'border-border text-fg-muted wp-interactive'
              }`}
            >
              Selections{selectionsCount > 0 ? ` (${selectionsCount})` : ''}
            </button>
            <SelectionsDrawer
              isOpen={isSelectionsOpen}
              onClose={() => setIsSelectionsOpen(false)}
              highlightGroups={highlightGroups || []}
              loadErrors={selectionLoadErrors}
              onActivate={onActivateHighlight}
              onRename={onRenameHighlight}
              onDelete={onDeleteHighlight}
              triggerRef={selectionsContainerRef}
              layout="sidebar"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex flex-wrap items-center gap-4 px-4 py-3 border-t border-border bg-bg-subtle">
      <ViewRecipeDropdown
        activeRecipeId={activeRecipeId ?? null}
        activeRecipeNameFallback={view?.recipe.name}
        recipes={viewRecipes ?? []}
        onSelectRecipe={onSelectRecipe}
        layout="bar"
      />
      <div className="w-px h-4 bg-border" />

      {showFocusControl && (
        <>
          <StructureFocusSelect
            members={focusMembers}
            activeMemberId={activeFocusMemberId}
            onFocusMemberChange={onFocusMemberChange}
            layout="bar"
          />
          <div className="w-px h-4 bg-border" />
        </>
      )}

      {}
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-muted">Color:</span>
        <MenuNativeSelect
          aria-label="Structure color mode"
          value={colorMode}
          onChange={(e) => onColorModeChange(e.target.value as Structure3dColorMode)}
          data-testid="color-mode-select"
        >
          {colorOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </MenuNativeSelect>
      </div>

      <div className="w-px h-4 bg-border" />

      {}
      <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
        <input
          type="checkbox"
          checked={showWater}
          onChange={(e) => onShowWaterChange(e.target.checked)}
          className="w-3 h-3 rounded border-border"
        />
        Water
      </label>

      <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
        <input
          type="checkbox"
          checked={spin}
          onChange={(e) => onSpinChange(e.target.checked)}
          className="w-3 h-3 rounded border-border"
        />
        Spin
      </label>

      {onVisibleBackboneSideChainsChange && (
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
          <input
            type="checkbox"
            checked={sideChains?.visibleBackbones === true}
            onChange={(e) => onVisibleBackboneSideChainsChange(e.target.checked)}
            className="w-3 h-3 rounded border-border"
            data-testid="structure-visible-backbone-sidechains-toggle"
          />
          Side chains
        </label>
      )}

      {}
      <div className="flex-1" />

      {}
      {onActivateHighlight && onRenameHighlight && onDeleteHighlight && (
        <div ref={selectionsContainerRef}>
          <button
            onClick={() => setIsSelectionsOpen(!isSelectionsOpen)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              selectionsCount > 0
                ? 'border-accent text-accent hover:bg-accent/10'
                : 'border-border text-fg-muted wp-interactive'
            }`}
          >
            Selections{selectionsCount > 0 ? ` (${selectionsCount})` : ''}
          </button>
        </div>
      )}

      {}
      {onActivateHighlight && onRenameHighlight && onDeleteHighlight && (
        <SelectionsDrawer
          isOpen={isSelectionsOpen}
          onClose={() => setIsSelectionsOpen(false)}
          highlightGroups={highlightGroups || []}
          loadErrors={selectionLoadErrors}
          onActivate={onActivateHighlight}
          onRename={onRenameHighlight}
          onDelete={onDeleteHighlight}
          triggerRef={selectionsContainerRef}
        />
      )}
    </div>
  );
});

function layerTargetsActiveFocus(target: ViewRecipe['layers'][number]['target']): boolean {
  if (target.kind === 'active-focus') return true;
  if (target.kind === 'ligand' && target.near) return layerTargetsActiveFocus(target.near);
  return false;
}
