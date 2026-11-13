'use client';

import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useCommandRegistry, COMMAND_IDS } from '../../../commands';
import { formatSelectionTm } from './format-selection-tm';
import type { LocalTmReadout } from '../../design/public/algorithms/local-tm';
import type { SequenceSelectionPreviewStore } from './sequence-selection-preview';
import {
  useSequenceSelectionStatistics,
  type SequenceSelectionStatisticsInput,
} from './useSequenceSelectionStatistics';
import type { ViewerConfig } from '../types';
import {
  ANNOTATION_DISPLAY_COLOR_OPTIONS,
  type AnnotationColorMode,
} from '@waypoint/sequence-utils';
import type {
  SequenceMapPlacement,
  SequenceRendererVisibility,
} from '../view-state/sequence-view-state';
import { SEQUENCE_VIEWER_TOOLS, type SequenceViewerTools } from '../viewer-tools';
import {
  PlannotateIcon,
  AlignmentIcon,
  AnnotationsIcon,
  TranslationIcon,
  ComplementIcon,
  PrimerIcon,
  CutSitesIcon,
  REToolIcon,
  StructureFileIcon,
  MetadataIcon,
  AssemblyTabIcon,
} from '@/components/icons';

interface SequenceToolbarSidebarProps {
  tools?: SequenceViewerTools;
  config: ViewerConfig;
  onConfigChange: (config: ViewerConfig) => void;
  sequenceLength?: number;
  selectionLength?: number;

  selectionTm?: number | null;

  selectionTmReadout?: LocalTmReadout | null;
  selectionPreview?: Omit<SequenceSelectionStatisticsInput, 'sequenceLength'> & {
    store: SequenceSelectionPreviewStore;
  };
  isEnzymePanelOpen?: boolean;
  onEnzymePanelToggle?: () => void;

  onOpenAlignments?: () => void;

  isAlignmentPanelOpen?: boolean;

  onOpenMetadata?: () => void;

  isMetadataOpen?: boolean;

  onOpenAssembly?: () => void;
  isAssemblyOpen?: boolean;
  isAssemblyAvailable?: boolean;

  onAutoAnnotateClick?: () => void;

  isAnnotationsDrawerOpen?: boolean;

  hasReviewSession?: boolean;

  isORFVisible?: boolean;

  onORFToggle?: () => void;

  onOpenGitHistory?: () => void;
  historyLabel?: string;

  isGitHistoryOpen?: boolean;

  onOpenPrimers?: () => void;

  isPrimersPanelOpen?: boolean;

  onOpenStructure?: () => void;

  isStructureDrawerOpen?: boolean;

  isStructureAvailable?: boolean;

  aaColorScheme?: string;

  onAAColorSchemeChange?: (scheme: string) => void;

  restrictionEnzymesDisabledReason?: string;

  cutSitesDisabledReason?: string;

  rendererVisibility?: SequenceRendererVisibility;
  onRendererVisibilityChange?: (visibility: SequenceRendererVisibility) => void;

  mapPlacement?: SequenceMapPlacement;
  onMapPlacementChange?: (placement: SequenceMapPlacement) => void;
}

export function SequenceToolbarSidebar({
  tools = SEQUENCE_VIEWER_TOOLS.sequence,
  config,
  onConfigChange,
  sequenceLength,
  selectionLength,
  selectionTm,
  selectionTmReadout,
  selectionPreview,
  isEnzymePanelOpen,
  onEnzymePanelToggle,
  onOpenAlignments,
  isAlignmentPanelOpen = false,
  onOpenMetadata,
  isMetadataOpen = false,
  onOpenAssembly,
  isAssemblyOpen = false,
  isAssemblyAvailable = false,
  onAutoAnnotateClick,
  isAnnotationsDrawerOpen = false,
  hasReviewSession = false,
  isORFVisible = false,
  onORFToggle,
  onOpenGitHistory,
  historyLabel = 'Git History',
  isGitHistoryOpen = false,
  onOpenPrimers,
  isPrimersPanelOpen = false,
  onOpenStructure,
  isStructureDrawerOpen = false,
  isStructureAvailable = false,
  aaColorScheme = 'none',
  onAAColorSchemeChange,
  rendererVisibility,
  onRendererVisibilityChange,
  mapPlacement = 'bottom',
  onMapPlacementChange,
  restrictionEnzymesDisabledReason,
  cutSitesDisabledReason,
}: SequenceToolbarSidebarProps) {
  const [viewPopoutOpen, setViewPopoutOpen] = useState(false);
  const updateConfig = useCallback(
    (updates: Partial<ViewerConfig>) => {
      onConfigChange({ ...config, ...updates });
    },
    [config, onConfigChange]
  );

  const { rail, display } = tools;
  const showOrfToggle = Boolean(onORFToggle) && display.has('orfs');
  const showDisplaySection = display.size > 0;
  const showMetadata = Boolean(onOpenMetadata) && rail.has('metadata');
  const showAssembly = Boolean(onOpenAssembly) && (isAssemblyOpen || isAssemblyAvailable);
  const showRestrictionEnzymes = rail.has('restriction-enzymes');
  const showAlignments = Boolean(onOpenAlignments) && rail.has('alignments');
  const showAnnotations = rail.has('annotations');
  const showPrimers = Boolean(onOpenPrimers) && rail.has('primers');
  const showGitHistory = Boolean(onOpenGitHistory) && rail.has('git-history');
  const showStructure = rail.has('structure');
  const showToolsSection =
    showRestrictionEnzymes ||
    showAlignments ||
    showAnnotations ||
    showPrimers ||
    showGitHistory ||
    showStructure;

  const showCompositionControls = Boolean(rendererVisibility && onRendererVisibilityChange);

  const showPlacementControls = Boolean(onMapPlacementChange && mapPlacement);

  return (
    <div
      data-ph-name="sequence-tool-rail"
      data-testid="sequence-tool-rail"
      className="w-12 shrink-0 border-l flex flex-col bg-bg-subtle border-border"
    >
      {}
      {showDisplaySection && (
        <div
          className="p-1.5 border-b border-border space-y-1 overflow-visible relative"
          data-ph-name="sequence-toolbar-display-section"
          data-testid="sequence-toolbar-display-section"
        >
          <SectionLabel>Display</SectionLabel>
          <TooltipWrapper tooltip="View options">
            <button
              onClick={() => setViewPopoutOpen(!viewPopoutOpen)}
              data-ph-name="toolbar-view-gear"
              data-testid="toolbar-view-gear"
              className={`
              w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
              transition-colors
              ${viewPopoutOpen ? 'text-accent bg-accent/10' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
            `}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: viewPopoutOpen ? 1 : 0.55 }}
              >
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </TooltipWrapper>

          {}
          {viewPopoutOpen && (
            <div
              className="absolute right-full top-0 mr-1 bg-bg-subtle border border-border rounded-lg shadow-lg p-1.5 space-y-1 z-50"
              style={{ width: 40 }}
            >
              {display.has('annotations') && (
                <ToolbarToggle
                  icon={<AnnotationsIcon size={22} hovered={config.showAnnotations} />}
                  title="Annotations"
                  active={config.showAnnotations}
                  onClick={() => updateConfig({ showAnnotations: !config.showAnnotations })}
                  testId="toolbar-toggle-annotations"
                />
              )}
              {display.has('annotation-color-mode') && (
                <AnnotationColorModeToggle
                  value={config.annotationColorMode}
                  onChange={(annotationColorMode) => updateConfig({ annotationColorMode })}
                />
              )}
              {display.has('translation') && (
                <TranslationToggle
                  active={config.showTranslation}
                  onClick={() => updateConfig({ showTranslation: !config.showTranslation })}
                  aaColorScheme={aaColorScheme}
                  onAAColorSchemeChange={onAAColorSchemeChange}
                />
              )}
              {display.has('translation') &&
                display.has('residue-numbers') &&
                config.showTranslation && (
                  <ToolbarToggle
                    icon="123"
                    title="Residue Numbers"
                    active={config.showResidueNumbers}
                    onClick={() => updateConfig({ showResidueNumbers: !config.showResidueNumbers })}
                    testId="toolbar-toggle-residue-numbers"
                  />
                )}
              {display.has('complement') && (
                <ComplementToggle
                  active={config.showReverseComplement}
                  onClick={() =>
                    updateConfig({ showReverseComplement: !config.showReverseComplement })
                  }
                />
              )}
              {display.has('primers') && (
                <PrimerToggle
                  active={config.showPrimers}
                  onClick={() => updateConfig({ showPrimers: !config.showPrimers })}
                />
              )}
              {display.has('cut-sites') && (
                <CutSitesToggle
                  active={config.showCutSites}
                  disabledReason={cutSitesDisabledReason}
                  onClick={() => updateConfig({ showCutSites: !config.showCutSites })}
                />
              )}
              {showOrfToggle && (
                <ToolbarToggle
                  icon="ORF"
                  title="Open Reading Frames"
                  active={isORFVisible}
                  onClick={onORFToggle}
                  testId="toolbar-toggle-orfs"
                />
              )}
            </div>
          )}
        </div>
      )}

      {}
      {(showMetadata || showAssembly) && (
        <div
          className="p-1.5 border-b border-border space-y-1 overflow-visible"
          data-ph-name="sequence-toolbar-details-section"
          data-testid="sequence-toolbar-details-section"
        >
          <SectionLabel>Details</SectionLabel>
          {onOpenMetadata && (
            <ToolbarToggle
              icon={<MetadataIcon className={isMetadataOpen ? 'opacity-100' : 'opacity-65'} />}
              title="Metadata"
              active={isMetadataOpen}
              onClick={onOpenMetadata}
              testId="toolbar-metadata"
            />
          )}
          {showAssembly && (
            <ToolbarToggle
              icon={<AssemblyTabIcon className="h-5 w-5" />}
              title="Assembly"
              active={isAssemblyOpen}
              onClick={onOpenAssembly}
              testId="toolbar-assembly"
            />
          )}
        </div>
      )}

      {showToolsSection && (
        <div
          className="p-1.5 border-b border-border space-y-1 overflow-visible"
          data-ph-name="sequence-toolbar-tools-section"
          data-testid="sequence-toolbar-tools-section"
        >
          <SectionLabel>Tools</SectionLabel>
          {showRestrictionEnzymes && (
            <REToolToggle
              active={isEnzymePanelOpen ?? false}
              onClick={onEnzymePanelToggle}
              disabledReason={restrictionEnzymesDisabledReason}
            />
          )}
          {showAlignments && onOpenAlignments && (
            <AlignmentToggle active={isAlignmentPanelOpen} onClick={onOpenAlignments} />
          )}
          {showAnnotations && (
            <AnnotationsToggle
              active={isAnnotationsDrawerOpen}
              onClick={onAutoAnnotateClick}
              hasReviewSession={hasReviewSession}
            />
          )}
          {showPrimers && (
            <ToolbarToggle
              icon={
                <PrimerIcon size={22} hovered={isPrimersPanelOpen} active={isPrimersPanelOpen} />
              }
              title="Primers"
              active={isPrimersPanelOpen}
              onClick={onOpenPrimers}
              testId="toolbar-primers"
            />
          )}
          {showGitHistory && (
            <ToolbarToggle
              icon="⌥"
              title={historyLabel}
              active={isGitHistoryOpen}
              onClick={onOpenGitHistory}
              testId="toolbar-git-history"
            />
          )}
          {showStructure && (
            <StructureToggle
              active={isStructureDrawerOpen}
              disabled={!isStructureAvailable}
              onClick={onOpenStructure}
            />
          )}
        </div>
      )}

      {showCompositionControls && (
        <div
          className="p-1.5 border-b border-border space-y-1 overflow-visible"
          data-ph-name="sequence-toolbar-view-section"
          data-testid="sequence-toolbar-view-section"
        >
          <SectionLabel>View</SectionLabel>
          {}
          <div
            data-ph-name="sequence-renderer-visibility-toggle"
            data-testid="sequence-renderer-visibility-toggle"
            className="space-y-1"
          >
            <CompositionButton
              title="Sequence"
              active={rendererVisibility === 'sequence'}
              onClick={() => onRendererVisibilityChange?.('sequence')}
              testId="sequence-renderer-visibility-sequence"
              icon={<SequenceGlyph />}
            />
            <CompositionButton
              title="Map"
              active={rendererVisibility === 'map'}
              onClick={() => onRendererVisibilityChange?.('map')}
              testId="sequence-renderer-visibility-map"
              icon={<MapGlyph />}
            />
            {showPlacementControls && (
              <>
                <MapPlacementAxisButton
                  axis="horizontal"
                  rendererVisibility={rendererVisibility}
                  mapPlacement={mapPlacement}
                  onRendererVisibilityChange={onRendererVisibilityChange}
                  onMapPlacementChange={onMapPlacementChange}
                />
                <MapPlacementAxisButton
                  axis="vertical"
                  rendererVisibility={rendererVisibility}
                  mapPlacement={mapPlacement}
                  onRendererVisibilityChange={onRendererVisibilityChange}
                  onMapPlacementChange={onMapPlacementChange}
                />
              </>
            )}
          </div>
        </div>
      )}

      {}
      <div className="flex-1" />

      {}
      {sequenceLength && (
        <div className="p-1.5 border-t border-border text-[9px] text-fg-muted text-center select-none cursor-default">
          {}
          {selectionPreview ? (
            <LiveSequenceSelectionReadout {...selectionPreview} sequenceLength={sequenceLength} />
          ) : (
            <SequenceSelectionReadout
              selectionLength={selectionLength}
              selectionTm={selectionTm}
              selectionTmReadout={selectionTmReadout}
            />
          )}
          {}
          <div>{sequenceLength.toLocaleString()}</div>
          <div>bp</div>
        </div>
      )}
    </div>
  );
}

function LiveSequenceSelectionReadout({
  store,
  ...input
}: SequenceSelectionStatisticsInput & { store: SequenceSelectionPreviewStore }) {
  const previewRange = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const statistics = useSequenceSelectionStatistics({
    ...input,
    highlightedRange: previewRange === undefined ? input.highlightedRange : previewRange,
  });
  return <SequenceSelectionReadout {...statistics} />;
}

function SequenceSelectionReadout({
  selectionLength,
  selectionTm,
  selectionTmReadout,
}: Pick<SequenceToolbarSidebarProps, 'selectionLength' | 'selectionTm' | 'selectionTmReadout'>) {
  const { dispatchCommand } = useCommandRegistry();
  const { text, title } = formatSelectionTm(selectionTmReadout, selectionTm);
  if (!selectionLength) return null;
  return (
    <div className="mb-2 pb-1.5 border-b border-border/50">
      <div
        className="text-fg font-medium"
        data-ph-name="selection-length"
        data-testid="selection-length"
      >
        {selectionLength} bp
      </div>
      {text !== null && (
        <div className="mt-0.5 flex items-center justify-center gap-1 text-fg-muted">
          <span data-ph-name="selection-tm" data-testid="selection-tm" title={title}>
            {text}
          </span>
          <button
            type="button"
            data-ph-name="selection-tm-settings"
            data-testid="selection-tm-settings"
            title="Configure Tm calculation"
            aria-label="Configure Tm calculation"
            onClick={() =>
              dispatchCommand(COMMAND_IDS.appOpenSettings, { payload: { focus: 'primer-tm' } })
            }
            className="text-fg-muted/70 transition-colors hover:text-fg"
          >
            <svg
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            >
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[8px] uppercase tracking-normal text-fg-muted text-center pb-1 pr-[1px] select-none cursor-default">
      {children}
    </div>
  );
}

function TooltipWrapper({ children, tooltip }: { children: React.ReactNode; tooltip: string }) {
  return (
    <div className="relative group">
      {children}
      <div
        className="
        absolute right-full top-1/2 -translate-y-1/2 mr-2
        px-2 py-1 text-xs whitespace-nowrap
        bg-[hsl(var(--color-tooltip-bg))] text-fg border border-fg-subtle/30 rounded shadow-sm
        opacity-0 group-hover:opacity-100
        pointer-events-none
        z-50
      "
      >
        {tooltip}
      </div>
    </div>
  );
}

interface ToolbarToggleProps {
  icon: React.ReactNode;
  title: string;
  active: boolean;
  onClick?: () => void;
  testId?: string;
}

function ToolbarToggle({ icon, title, active, onClick, testId }: ToolbarToggleProps) {
  return (
    <TooltipWrapper tooltip={title}>
      <button
        onClick={onClick}
        disabled={!onClick}
        data-ph-name={testId ?? `sequence-toolbar-${title.toLowerCase().replaceAll(' ', '-')}`}
        data-testid={testId}
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        {icon}
      </button>
    </TooltipWrapper>
  );
}

function CompositionButton({
  icon,
  title,
  ariaLabel,
  active,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  title: string;

  ariaLabel?: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <TooltipWrapper tooltip={title}>
      <button
        type="button"
        onClick={onClick}
        data-ph-name={testId}
        data-testid={testId}
        aria-label={ariaLabel ?? title}
        aria-pressed={active}
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {icon}
      </button>
    </TooltipWrapper>
  );
}

const HORIZONTAL_PLACEMENTS = ['right', 'left'] as const;
const VERTICAL_PLACEMENTS = ['bottom', 'top'] as const;

function MapPlacementAxisButton({
  axis,
  rendererVisibility,
  mapPlacement,
  onRendererVisibilityChange,
  onMapPlacementChange,
}: {
  axis: 'horizontal' | 'vertical';
  rendererVisibility?: SequenceRendererVisibility;
  mapPlacement: SequenceMapPlacement;
  onRendererVisibilityChange?: (visibility: SequenceRendererVisibility) => void;
  onMapPlacementChange?: (placement: SequenceMapPlacement) => void;
}) {
  const options = axis === 'horizontal' ? HORIZONTAL_PLACEMENTS : VERTICAL_PLACEMENTS;
  const inSplit = rendererVisibility === 'both';
  const active = inSplit && (options as readonly string[]).includes(mapPlacement);

  const shown = active ? mapPlacement : options[0];
  const next = active ? (mapPlacement === options[0] ? options[1] : options[0]) : options[0];

  const title = axis === 'horizontal' ? 'Side by side' : 'Top and bottom';
  const spokenPlacement =
    shown === 'left'
      ? 'map on the left'
      : shown === 'right'
        ? 'map on the right'
        : shown === 'top'
          ? 'map on top'
          : 'map on the bottom';

  return (
    <CompositionButton
      title={title}
      ariaLabel={`${title}, ${spokenPlacement}`}
      active={active}
      onClick={() => {
        onMapPlacementChange?.(next);
        if (!inSplit) onRendererVisibilityChange?.('both');
      }}
      testId={`sequence-map-placement-${axis}`}
      icon={<MapPlacementGlyph placement={shown} />}
    />
  );
}

function SequenceGlyph() {
  return (
    <svg
      data-sidebar-view-icon="sequence"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="26" height="24" rx="3.5" stroke="currentColor" strokeWidth="1.7" />
      {}
      <text
        data-glyph-row="1"
        x="16"
        y="14.6"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-mono)"
        fontSize="7.4"
        fontWeight="600"
        letterSpacing="0.35"
      >
        ACGT
      </text>
      <text
        data-glyph-row="2"
        x="16"
        y="23.4"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-mono)"
        fontSize="7.4"
        fontWeight="600"
        letterSpacing="0.35"
      >
        TATC
      </text>
    </svg>
  );
}

function MapGlyph() {
  return (
    <svg
      data-sidebar-view-icon="map"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="26" height="24" rx="3.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16" cy="16" r="7.2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12.7 9.6a7.2 7.2 0 0 1 8.8 3.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="21.8" cy="13.6" r="1.05" fill="currentColor" />
    </svg>
  );
}

function MapPlacementGlyph({ placement }: { placement: SequenceMapPlacement }) {
  const isHorizontal = placement === 'left' || placement === 'right';
  const mapArea =
    placement === 'left'
      ? { x: 3, y: 4, width: 13, height: 24, cx: 9.5, cy: 16, r: 3.25 }
      : placement === 'right'
        ? { x: 16, y: 4, width: 13, height: 24, cx: 22.5, cy: 16, r: 3.25 }
        : placement === 'top'
          ? { x: 3, y: 4, width: 26, height: 12, cx: 16, cy: 10, r: 3 }
          : { x: 3, y: 16, width: 26, height: 12, cx: 16, cy: 22, r: 3 };

  const baseRows: Array<{ x: number; y: number; text: string }> = isHorizontal
    ? (() => {
        const x = placement === 'left' ? 22.5 : 9.5;
        return [
          { x, y: 15.1, text: 'AC' },
          { x, y: 22.9, text: 'GT' },
        ];
      })()
    : [{ x: 16, y: placement === 'top' ? 24.1 : 12.5, text: 'ACGT' }];

  return (
    <svg
      data-sidebar-view-icon={`placement-${placement}`}
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="26" height="24" rx="3.5" stroke="currentColor" strokeWidth="1.7" />
      <rect
        x={mapArea.x}
        y={mapArea.y}
        width={mapArea.width}
        height={mapArea.height}
        fill="currentColor"
        opacity="0.12"
      />
      {isHorizontal ? (
        <path d="M16 4v24" stroke="currentColor" strokeWidth="1.2" />
      ) : (
        <path d="M3 16h26" stroke="currentColor" strokeWidth="1.2" />
      )}
      <circle
        cx={mapArea.cx}
        cy={mapArea.cy}
        r={mapArea.r}
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <circle
        cx={mapArea.cx + mapArea.r * 0.65}
        cy={mapArea.cy - mapArea.r * 0.65}
        r="0.62"
        fill="currentColor"
      />
      {baseRows.map((row, index) => (
        <text
          key={row.text}
          data-glyph-row={String(index + 1)}
          x={row.x}
          y={row.y}
          textAnchor="middle"
          fill="currentColor"
          stroke="none"
          fontFamily="var(--font-mono)"
          fontSize={isHorizontal ? '6.2' : '6.6'}
          fontWeight="600"
          letterSpacing="0.3"
        >
          {row.text}
        </text>
      ))}
    </svg>
  );
}
function ComplementToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper tooltip="Complement">
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-ph-name="toolbar-toggle-complement"
        data-testid="toolbar-toggle-complement"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <ComplementIcon size={22} hovered={active || hovered} active={active} />
      </button>
    </TooltipWrapper>
  );
}

function PrimerToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper tooltip="Primers">
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-ph-name="toolbar-toggle-primers"
        data-testid="toolbar-toggle-primers"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <PrimerIcon size={28} hovered={active || hovered} active={active} />
      </button>
    </TooltipWrapper>
  );
}

function AlignmentToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper tooltip="Alignments">
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-ph-name="toolbar-alignments"
        data-testid="toolbar-alignments"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <AlignmentIcon size={28} hovered={active || hovered} />
      </button>
    </TooltipWrapper>
  );
}

function StructureToggle({
  active,
  disabled,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  onClick?: () => void;
}) {
  return (
    <TooltipWrapper
      tooltip={
        disabled ? 'Structure — select a gene or RNA feature to view its structure' : 'Structure'
      }
    >
      <button
        onClick={onClick}
        disabled={disabled}
        data-ph-name="toolbar-structure"
        data-testid="toolbar-structure"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <StructureFileIcon className="w-6 h-6" />
      </button>
    </TooltipWrapper>
  );
}

function AnnotationColorModeToggle({
  value,
  onChange,
}: {
  value: AnnotationColorMode;
  onChange: (value: AnnotationColorMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeOption = ANNOTATION_DISPLAY_COLOR_OPTIONS.find((option) => option.id === value);

  return (
    <div className="relative">
      <TooltipWrapper tooltip={`Annotation colors: ${activeOption?.label ?? 'Type'}`}>
        <button
          onClick={() => setOpen(!open)}
          data-ph-name="toolbar-annotation-color-mode"
          data-testid="toolbar-annotation-color-mode"
          aria-label="Annotation color mode"
          className={`
            w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
            transition-colors
            ${open ? 'text-accent bg-accent/10' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
          `}
        >
          <span className="grid grid-cols-2 gap-[2px]" aria-hidden="true">
            <span className="w-2 h-2 rounded-sm bg-blue-500" />
            <span className="w-2 h-2 rounded-sm bg-emerald-500" />
            <span className="w-2 h-2 rounded-sm bg-purple-500" />
            <span className="w-2 h-2 rounded-sm bg-gray-400" />
          </span>
        </button>
      </TooltipWrapper>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-full top-0 mr-1 bg-bg-subtle border border-border rounded-lg shadow-lg p-1 z-50"
            style={{ width: 116 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
            tabIndex={-1}
            ref={(el) => el?.focus()}
          >
            <div className="text-[8px] uppercase tracking-normal text-fg-muted text-center pb-1 select-none">
              Colors
            </div>
            {ANNOTATION_DISPLAY_COLOR_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                data-ph-name={`toolbar-annotation-color-mode-${option.id}`}
                data-testid={`toolbar-annotation-color-mode-${option.id}`}
                className={`w-full text-left px-2 py-1 text-[10px] rounded transition-colors ${
                  value === option.id
                    ? 'text-accent font-medium bg-accent/10'
                    : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                }`}
                title={option.description}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TranslationToggle({
  active,
  onClick,
  aaColorScheme,
  onAAColorSchemeChange,
}: {
  active: boolean;
  onClick: () => void;
  aaColorScheme?: string;
  onAAColorSchemeChange?: (scheme: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [aaOpen, setAAOpen] = useState(false);

  return (
    <div className="relative">
      <TooltipWrapper tooltip="Translation">
        <button
          onClick={onClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          data-ph-name="toolbar-toggle-translation"
          data-testid="toolbar-toggle-translation"
          data-active={active}
          className={`
            w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
            transition-colors
            ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
          `}
        >
          {active && (
            <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
          )}
          <TranslationIcon size={28} hovered={active || hovered} />
          {}
          {active && onAAColorSchemeChange && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setAAOpen(!aaOpen);
              }}
              className="absolute -bottom-1 -left-1 w-4 h-4 flex items-center justify-center cursor-pointer transition-opacity text-accent opacity-50 hover:opacity-100"
              data-ph-name="toolbar-aa-color-menu"
              title="AA color scheme"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
          )}
        </button>
      </TooltipWrapper>
      {}
      {aaOpen && active && (
        <>
          {}
          <div className="fixed inset-0 z-40" onClick={() => setAAOpen(false)} />
          <div
            className="absolute right-full top-0 mr-1 bg-bg-subtle border border-border rounded-lg shadow-lg p-1 z-50"
            style={{ width: 100 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAAOpen(false);
            }}
            tabIndex={-1}
            ref={(el) => el?.focus()}
          >
            <div className="text-[8px] uppercase tracking-normal text-fg-muted text-center pb-1 select-none">
              AA Colors
            </div>
            {[
              { id: 'none', label: 'None' },
              { id: 'rasmol', label: 'RasMol' },
              { id: 'hydrophobicity', label: 'Hydrophobic' },
              { id: 'clustalx', label: 'Clustal X' },
            ].map(({ id, label }) => (
              <button
                key={id}
                data-ph-name={`toolbar-aa-color-${id}`}
                onClick={() => onAAColorSchemeChange?.(id)}
                className={`w-full text-left px-2 py-1 text-[10px] rounded transition-colors ${
                  aaColorScheme === id
                    ? 'text-accent font-medium bg-accent/10'
                    : 'text-fg-muted hover:bg-bg-muted hover:text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CutSitesToggle({
  active,
  onClick,
  disabledReason,
}: {
  active: boolean;
  onClick: () => void;
  disabledReason?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper
      tooltip={
        disabledReason != null
          ? toUserMessage(disabledReason, 'failure.cut-sites')
          : userMessage('failure.cut-sites')
      }
    >
      <button
        onClick={onClick}
        disabled={disabledReason !== undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-ph-name="toolbar-toggle-cut-sites"
        data-testid="toolbar-toggle-cut-sites"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <CutSitesIcon size={28} hovered={active || hovered} active={active} />
      </button>
    </TooltipWrapper>
  );
}

function REToolToggle({
  active,
  onClick,
  disabledReason,
}: {
  active: boolean;
  onClick?: () => void;
  disabledReason?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper
      tooltip={
        disabledReason != null
          ? toUserMessage(disabledReason, 'failure.restriction-enzymes')
          : userMessage('failure.restriction-enzymes')
      }
    >
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        disabled={!onClick || disabledReason !== undefined}
        data-ph-name="toolbar-restriction-enzymes"
        data-testid="toolbar-restriction-enzymes"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <REToolIcon size={28} hovered={active || hovered} />
      </button>
    </TooltipWrapper>
  );
}

function AnnotationsToggle({
  active,
  onClick,
  hasReviewSession = false,
}: {
  active: boolean;
  onClick?: () => void;
  hasReviewSession?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <TooltipWrapper tooltip={hasReviewSession ? 'Annotations (unsaved results)' : 'Annotations'}>
      <button
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        disabled={!onClick}
        data-ph-name="toolbar-auto-annotate"
        data-testid="toolbar-auto-annotate"
        data-active={active}
        className={`
          w-full h-8 flex items-center justify-center rounded text-sm relative overflow-visible
          transition-colors
          ${active ? 'text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg'}
        `}
      >
        {active && (
          <div className="absolute -right-1.5 -top-0.5 w-[2px] h-[calc(100%+4px)] bg-accent dark:bg-accent" />
        )}
        <PlannotateIcon size={22} hovered={active || hovered} />
        {hasReviewSession && !active && (
          <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-yellow-500 dark:bg-yellow-400" />
        )}
      </button>
    </TooltipWrapper>
  );
}
