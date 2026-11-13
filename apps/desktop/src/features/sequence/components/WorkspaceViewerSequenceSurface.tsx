import type { ReactNode } from 'react';
import { DEFAULT_EDITOR_CONFIG } from '@waypoint/workspace-editor';
import { EmptySequenceEntryCue } from './EmptySequenceEntryCue';
import { SequencePaneControls } from './SequencePaneControls';
import type { SequenceViewMode } from './SequenceViewerModeToggle';
import { sequenceSurfaceMode } from './workspace-viewer-sequence-surface';
import type { EmptySequenceEntryCue as EmptySequenceEntryCueVariant } from '../empty-sequence-entry-store';

export function WorkspaceViewerSequenceSurface({
  sequenceSurfaceVisible,
  sequenceViewMode,
  tracks,
  canvas2d,
  emptySequenceEntryVisible,
  emptySequenceEntryCue,
  emptyCueRowHeight,
  zoom,
  minZoom,
  onModeChange,
  showModeToggle = false,
  tracksLabel,
  onZoomChange,
}: {
  sequenceSurfaceVisible: boolean;
  sequenceViewMode: SequenceViewMode;
  tracks: ReactNode;
  canvas2d: ReactNode;
  emptySequenceEntryVisible: boolean;
  emptySequenceEntryCue: EmptySequenceEntryCueVariant;
  emptyCueRowHeight: number;
  zoom: number;
  minZoom?: number;
  onModeChange: (mode: SequenceViewMode) => void;
  showModeToggle?: boolean;
  tracksLabel?: string;
  onZoomChange: (zoom: number) => void;
}): ReactNode {
  const mode = sequenceSurfaceMode(sequenceSurfaceVisible, sequenceViewMode);
  if (mode === 'hidden') {
    return emptySequenceEntryVisible ? (
      <EmptySequenceEntryCue
        variant={emptySequenceEntryCue}
        marginLeft={DEFAULT_EDITOR_CONFIG.marginLeft}
        rowHeight={emptyCueRowHeight}
      />
    ) : null;
  }
  return (
    <>
      {mode === 'tracks' ? tracks : canvas2d}
      {emptySequenceEntryVisible ? (
        <EmptySequenceEntryCue
          variant={emptySequenceEntryCue}
          marginLeft={DEFAULT_EDITOR_CONFIG.marginLeft}
          rowHeight={emptyCueRowHeight}
        />
      ) : null}
      <SequencePaneControls
        mode={sequenceViewMode}
        onModeChange={onModeChange}
        showModeToggle={showModeToggle}
        tracksLabel={tracksLabel}
        zoom={zoom}
        minZoom={minZoom}
        onZoomChange={onZoomChange}
      />
    </>
  );
}
