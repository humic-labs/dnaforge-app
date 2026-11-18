import React from 'react';
import type { VerificationTrack, TrackStatus } from '../types';
import { getEffectiveStatus } from '../types';
import { EyeIcon, EyeOffIcon } from './icons';
import { InlineEditableText } from './InlineEditableText';
import { StatusOverridePopover } from './StatusOverridePopover';
import { StatusBadge } from './StatusBadge';
import { getAlignmentEvidence } from '../utils/mutation-computation';

function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getMutationSummary(track: VerificationTrack): {
  text: string;
  severity: 'high' | 'medium' | 'low' | 'none';
} {
  const analysis = track.structuralAnalysis;

  if (analysis) {
    const hasHighSeverity = analysis.structuralRegions.some((r) => r.severity === 'high');
    const hasMediumSeverity = analysis.structuralRegions.some((r) => r.severity === 'medium');
    const structuralCount = analysis.structuralRegions.length;
    const pointCount = analysis.pointMutationIndices.length;

    if (hasHighSeverity) {
      const highRegion = analysis.structuralRegions.find((r) => r.severity === 'high');
      return { text: highRegion?.type.replace(/_/g, ' ') || 'structural', severity: 'high' };
    }
    if (hasMediumSeverity) {
      return { text: `${structuralCount} structural`, severity: 'medium' };
    }
    if (pointCount > 0) {
      return { text: `${pointCount} point`, severity: 'low' };
    }
    return { text: 'None', severity: 'none' };
  }

  const count = track.mutations.length;
  if (count === 0) return { text: 'None', severity: 'none' };
  return { text: `${count}`, severity: 'low' };
}

export interface CloneListItemProps {
  track: VerificationTrack;
  index: number;
  isSelected: boolean;
  isStale: boolean;
  isPending: boolean;
  isTrackHidden: boolean;
  statusOverrideTrackId: string | null;
  onSelect: (index: number) => void;
  onKeyDown: (e: React.KeyboardEvent, index: number, maxIndex: number) => void;
  onToggleVisibility: () => void;
  onStatusOverrideToggle: () => void;
  onStatusOverride: (status: TrackStatus | null, reason?: string) => void;
  onStatusOverrideClose: () => void;
  onRename: (label: string) => void;
  onRemove?: () => void;
  maxIndex: number;
}

export const CloneListItem = React.forwardRef<HTMLDivElement, CloneListItemProps>(
  function CloneListItem(
    {
      track,
      index,
      isSelected,
      isStale,
      isPending,
      isTrackHidden,
      statusOverrideTrackId,
      onSelect,
      onKeyDown,
      onToggleVisibility,
      onStatusOverrideToggle,
      onStatusOverride,
      onStatusOverrideClose,
      onRename,
      onRemove,
      maxIndex,
    },
    ref
  ) {
    const statusButtonRef = React.useRef<HTMLButtonElement>(null);
    const summary = getMutationSummary(track);
    const evidence = React.useMemo(
      () => getAlignmentEvidence(track.alignment.alignedReference, track.alignment.alignedQuery),
      [track.alignment]
    );
    const severityColor = {
      high: 'text-red-400',
      medium: 'text-yellow-400',
      low: 'text-blue-400',
      none: 'text-green-400',
    }[summary.severity];
    const computedStatus = evidence.complete ? track.status : 'incomplete';
    const effectiveStatus = getEffectiveStatus({ ...track, status: computedStatus });
    const isOverridden = track.userStatus !== undefined;

    return (
      <div
        ref={ref}
        role="option"
        data-testid="alignment-clone-row"
        data-track-label={track.label}
        aria-selected={isSelected}
        tabIndex={isSelected ? 0 : -1}
        onClick={() => onSelect(index)}
        onKeyDown={(e) => onKeyDown(e, index, maxIndex)}
        className={`group flex items-center gap-3 px-4 py-2 cursor-pointer outline-none ${
          isSelected ? 'bg-accent/10' : 'wp-interactive'
        } ${isTrackHidden ? 'opacity-50' : ''} ${isStale ? 'opacity-60' : ''}`}
      >
        {}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility();
          }}
          className={`p-0.5 rounded transition-colors ${
            isTrackHidden ? 'text-fg-muted wp-interactive' : 'text-fg-muted/50 wp-interactive'
          }`}
          title={isTrackHidden ? 'Show track in viewer' : 'Hide track from viewer'}
        >
          {isTrackHidden ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
        </button>
        {}
        {isPending ? (
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
        ) : track.failedToRealign ? (
          <div
            className="w-4 h-4 flex items-center justify-center text-red-500 flex-shrink-0"
            title="Re-alignment failed — click Re-run to retry"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
            </svg>
          </div>
        ) : (
          <div className="relative">
            <button
              ref={statusButtonRef}
              aria-haspopup="dialog"
              aria-expanded={statusOverrideTrackId === track.id}
              onClick={(e) => {
                e.stopPropagation();
                onStatusOverrideToggle();
              }}
              title={
                isOverridden
                  ? `Computed: ${computedStatus}, Override: ${track.userStatus}${track.userOverrideReason ? ` — ${track.userOverrideReason}` : ''}`
                  : `Status: ${computedStatus} (click to override)`
              }
            >
              <StatusBadge status={effectiveStatus} />
              {isOverridden && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-accent rounded-full" />
              )}
            </button>
            {statusOverrideTrackId === track.id && (
              <StatusOverridePopover
                track={track}
                anchorRef={statusButtonRef}
                onOverride={onStatusOverride}
                onClose={onStatusOverrideClose}
              />
            )}
          </div>
        )}
        <InlineEditableText
          value={track.label}
          onSave={onRename}
          className={`font-medium text-sm flex-1 truncate ${isPending ? 'text-fg-muted italic' : ''} ${track.failedToRealign ? 'text-red-500' : ''}`}
        />
        {isPending ? (
          <span className="text-xs text-fg-muted italic">Aligning…</span>
        ) : track.failedToRealign ? (
          <span className="text-xs text-red-500 italic">Failed</span>
        ) : (
          <>
            <span
              className="text-xs text-fg-muted font-mono"
              title="Identity across resolved alignment positions; this does not establish complete sequence coverage."
            >
              {track.alignment.identity === 100 && track.mutations.length > 0
                ? '>99.99'
                : track.alignment.identity.toFixed(2)}
              %
            </span>
            <span className={`text-xs ${!evidence.complete ? 'text-fg-muted' : severityColor}`}>
              {!evidence.complete && summary.severity === 'none' ? 'Incomplete' : summary.text}
            </span>
            <span
              className={`text-[10px] ${isStale ? 'text-amber-700 dark:text-yellow-400' : 'text-fg-muted/50'}`}
              title={new Date(track.alignedAt).toLocaleString()}
            >
              {relativeTime(track.alignedAt)}
            </span>
          </>
        )}
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="text-fg-muted hover:text-red-500 p-1 rounded hover:bg-red-500/10 opacity-0 group-hover:opacity-100"
            aria-label="Remove"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    );
  }
);
