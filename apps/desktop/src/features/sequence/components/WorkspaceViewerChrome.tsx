import type { ComponentProps, ReactNode } from 'react';
import { FindBar } from '@waypoint/workspace-editor';

type FindBarProps = ComponentProps<typeof FindBar>;

export function WorkspaceViewerEditModeBar({
  isEditMode,
  onDiscard,
  onCommit,
  discardDisabled = false,
  commitDisabled = false,
  commitLabel = 'Save',
}: {
  isEditMode: boolean;
  onDiscard: () => void;
  onCommit: () => void;
  discardDisabled?: boolean;
  commitDisabled?: boolean;
  commitLabel?: string;
}): ReactNode {
  if (!isEditMode) return null;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b"
      style={{
        backgroundColor: 'rgba(234, 179, 8, 0.1)',
        borderColor: 'rgba(234, 179, 8, 0.2)',
      }}
      data-testid="edit-mode-bar"
    >
      <span className="text-xs" style={{ color: 'hsl(var(--color-fg-subtle))' }}>
        Editing
      </span>
      <div style={{ flex: 1 }} />
      <button
        onClick={onDiscard}
        disabled={discardDisabled}
        className="px-3 py-1 text-xs rounded"
        style={{
          border: '1px solid hsl(var(--color-border))',
          backgroundColor: 'transparent',
          cursor: discardDisabled ? 'default' : 'pointer',
          opacity: discardDisabled ? 0.45 : 1,
        }}
        data-testid="edit-mode-discard-btn"
      >
        Discard
      </button>
      <button
        onClick={onCommit}
        disabled={commitDisabled}
        className="px-3 py-1 text-xs rounded"
        style={{
          backgroundColor: 'hsl(var(--color-accent))',
          color: 'hsl(var(--color-bg))',
          border: 'none',
          cursor: commitDisabled ? 'default' : 'pointer',
          opacity: commitDisabled ? 0.45 : 1,
        }}
        data-testid="edit-mode-save-btn"
      >
        {commitLabel}
      </button>
    </div>
  );
}

export function WorkspaceViewerFindOverlay({
  isOpen,
  isGapped,
  query,
  mode,
  matchCount,
  activeIndex,
  isActiveReverse,
  isError,
  errorMessage,
  matches,
  onQueryChange,
  onModeChange,
  onNext,
  onPrev,
  onClose,
  onActivateMatch,
}: {
  isOpen: boolean;
  isGapped: boolean;
  query: FindBarProps['query'];
  mode: FindBarProps['mode'];
  matchCount: FindBarProps['matchCount'];
  activeIndex: FindBarProps['activeIndex'];
  isActiveReverse: FindBarProps['isActiveReverse'];
  isError: FindBarProps['isError'];
  errorMessage: FindBarProps['errorMessage'];
  matches: FindBarProps['matches'];
  onQueryChange: FindBarProps['onQueryChange'];
  onModeChange: FindBarProps['onModeChange'];
  onNext: FindBarProps['onNext'];
  onPrev: FindBarProps['onPrev'];
  onClose: FindBarProps['onClose'];
  onActivateMatch: FindBarProps['onActivateMatch'];
}): ReactNode {
  if (!isOpen || isGapped) return null;
  return (
    <FindBar
      query={query}
      mode={mode}
      matchCount={matchCount}
      activeIndex={activeIndex}
      isActiveReverse={isActiveReverse}
      isError={isError}
      errorMessage={errorMessage}
      matches={matches}
      onQueryChange={onQueryChange}
      onModeChange={onModeChange}
      onNext={onNext}
      onPrev={onPrev}
      onClose={onClose}
      onActivateMatch={onActivateMatch}
    />
  );
}

export function optionalEnzymeDrawer(isOpen: boolean, drawer: ReactNode): ReactNode {
  return isOpen ? drawer : undefined;
}
