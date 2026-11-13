import {
  renderUserMessage,
  userEntityLabel,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { Fragment, useRef, useEffect, useCallback, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SearchMode } from './hooks/useSequenceSearch';
import type { SearchMatch } from '@waypoint/sequence-utils';
import { formatShortcut, matchesShortcut, JETBRAINS_MONO_FONT_NAME } from '@waypoint/platform';

const FIND_BAR_WIDTH = 560;
const FIND_BAR_HEIGHT = 32;
const FIND_BAR_INPUT_WIDTH = 300;
const FIND_BAR_MODE_WIDTH = 48;
const FIND_BAR_NAV_WIDTH = 24;
const FIND_BAR_STATUS_WIDTH = 130;
const FIND_BAR_CLOSE_WIDTH = 18;

export interface FindBarAnnotationBadgeStyle {
  readonly background: string;
  readonly color?: string;
  readonly accent?: string;
}

export interface FindBarProps {
  query: string;
  mode: SearchMode;
  minQueryLength?: number;
  matchCount: number;
  isTruncated?: boolean;
  activeIndex: number;
  isActiveReverse: boolean;
  isSearching?: boolean;
  isError: boolean;
  errorMessage: UserMessage | null;
  matches?: SearchMatch[];
  modeToggleDisabled?: boolean;
  modeToggleDisabledReason?: UserMessage;
  onQueryChange: (q: string) => void;
  onModeChange: (mode: SearchMode) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onActivateMatch?: (index: number) => void;
  resolveAnnotationBadgeStyle?: (match: SearchMatch) => FindBarAnnotationBadgeStyle;
}

export function FindBar({
  query,
  mode,
  minQueryLength = 2,
  matchCount,
  isTruncated = false,
  activeIndex,
  isActiveReverse,
  isSearching = false,
  isError,
  errorMessage,
  matches = [],
  modeToggleDisabled = false,
  modeToggleDisabledReason,
  onQueryChange,
  onModeChange,
  onNext,
  onPrev,
  onClose,
  onActivateMatch,
  resolveAnnotationBadgeStyle,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (matches.length > 0 && query) {
      setDropdownOpen(true);
    } else {
      setDropdownOpen(false);
    }
  }, [matches.length, query]);

  const showDropdown = dropdownOpen && matches.length > 0;

  useEffect(() => {
    if (!showDropdown || activeIndex < 0 || !dropdownRef.current) return;
    const item = dropdownRef.current.querySelector<HTMLElement>(
      `[data-match-index="${activeIndex}"]`
    );
    if (typeof item?.scrollIntoView !== 'function') return;
    item.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showDropdown]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (matchCount > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        if (e.key === 'ArrowDown') onNext();
        else onPrev();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          onPrev();
        } else {
          onNext();
        }
        return;
      }

      if (matchesShortcut(e, ['cmd', 'f'])) {
        e.preventDefault();
        e.stopPropagation();
        if (!modeToggleDisabled) {
          onModeChange(mode === 'nucleotide' ? 'aminoAcid' : 'nucleotide');
        }
        return;
      }
    },
    [onClose, onNext, onPrev, onModeChange, mode, matchCount, modeToggleDisabled]
  );

  const toggleMode = useCallback(() => {
    if (modeToggleDisabled) return;
    onModeChange(mode === 'nucleotide' ? 'aminoAcid' : 'nucleotide');
  }, [mode, modeToggleDisabled, onModeChange]);

  const trimmedQueryLength = query.trim().length;
  const isTooShort = trimmedQueryLength > 0 && trimmedQueryLength < minQueryLength;
  let counterText: string;
  if (errorMessage) {
    counterText = renderUserMessage(errorMessage);
  } else if (!query || isTooShort) {
    counterText = '';
  } else if (isSearching) {
    counterText = 'Searching…';
  } else if (matchCount === 0) {
    counterText = 'No matches';
  } else {
    counterText = `${activeIndex + 1} of ${matchCount}${isTruncated ? '+' : ''}`;
    if (isActiveReverse) counterText += ' (rev)';
  }

  const hasNoMatches =
    query.length > 0 && matchCount === 0 && !isError && !isTooShort && !isSearching;
  const hasError = isError;
  const placeholder = mode === 'nucleotide' ? 'Search DNA bases...' : 'Search AA or features...';
  const modeLabel = mode === 'nucleotide' ? 'DNA' : 'AA+';
  const modeAriaLabel =
    mode === 'nucleotide' ? 'Search mode: DNA bases' : 'Search mode: AA and features';
  const shortcutLabel = getFindShortcutLabel();
  const shortcutCue =
    !query && !errorMessage
      ? mode === 'nucleotide'
        ? `${shortcutLabel} again for AA/features`
        : `${shortcutLabel} again for DNA`
      : '';
  const modeToggleTitle =
    modeToggleDisabled && modeToggleDisabledReason
      ? modeToggleDisabledReason
      : mode === 'nucleotide'
        ? userMessageWithValues('sequenceSearch.switchToAnnotations', {
            shortcut: userMessageValue(shortcutLabel),
          })
        : userMessageWithValues('sequenceSearch.switchToBases', {
            shortcut: userMessageValue(shortcutLabel),
          });

  return (
    <div
      data-testid="findbar-shell"
      style={{
        position: 'absolute',
        top: 0,
        right: 8,
        zIndex: 20,
        width: FIND_BAR_WIDTH,
        maxWidth: 'calc(100vw - 16px)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {}
      <div
        role="search"
        aria-label="Find in sequence"
        aria-busy={isSearching}
        style={{
          background: 'hsl(var(--color-bg))',
          border: '1px solid hsl(var(--color-border))',
          borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
          padding: '4px 8px',
          height: FIND_BAR_HEIGHT,
          width: FIND_BAR_WIDTH,
          maxWidth: 'calc(100vw - 16px)',
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: `${FIND_BAR_INPUT_WIDTH}px ${FIND_BAR_MODE_WIDTH}px ${FIND_BAR_NAV_WIDTH}px ${FIND_BAR_STATUS_WIDTH}px ${FIND_BAR_CLOSE_WIDTH}px`,
          alignItems: 'center',
          columnGap: 6,
        }}
      >
        {}
        <span
          style={{ position: 'relative', display: 'inline-block', width: FIND_BAR_INPUT_WIDTH }}
        >
          <input
            ref={inputRef}
            type="text"
            data-command-shortcut-owner="sequence.find"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label="Search pattern"
            style={{
              background: hasNoMatches
                ? 'hsla(var(--color-error), 0.08)'
                : 'hsl(var(--color-bg-subtle))',
              border: `1px solid ${
                hasError || hasNoMatches
                  ? 'hsla(var(--color-error), 0.3)'
                  : 'hsl(var(--color-border))'
              }`,
              borderRadius: 4,
              width: FIND_BAR_INPUT_WIDTH,
              height: 24,
              boxSizing: 'border-box',
              fontFamily: `'${JETBRAINS_MONO_FONT_NAME}', 'Roboto Mono', monospace`,
              fontSize: 12,
              padding: '2px 6px',
              outline: 'none',
              color: 'hsl(var(--color-fg))',
              display: 'block',
            }}
          />
          {isTooShort && !errorMessage && (
            <span
              role="status"
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: 'hsl(var(--color-fg-subtle))',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: 10,
                whiteSpace: 'nowrap',
                opacity: 0.75,
              }}
            >
              type {minQueryLength}+ chars
            </span>
          )}
        </span>

        {}
        <button
          onClick={toggleMode}
          disabled={modeToggleDisabled}
          aria-label={modeAriaLabel}
          title={modeToggleTitle}
          style={{
            background: 'hsl(var(--color-bg-muted))',
            border: '1px solid hsl(var(--color-border))',
            borderRadius: 4,
            width: FIND_BAR_MODE_WIDTH,
            boxSizing: 'border-box',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            cursor: modeToggleDisabled ? 'not-allowed' : 'pointer',
            opacity: modeToggleDisabled ? 0.55 : 1,
            color: 'hsl(var(--color-fg))',
            lineHeight: '16px',
          }}
        >
          {modeLabel}
        </button>

        {}
        <span
          style={{
            display: 'inline-flex',
            gap: 0,
            width: FIND_BAR_NAV_WIDTH,
            justifyContent: 'center',
          }}
        >
          <button
            onClick={onPrev}
            disabled={matchCount === 0}
            aria-label="Previous match"
            style={{
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              padding: '2px 1px',
              cursor: matchCount > 0 ? 'pointer' : 'default',
              opacity: matchCount > 0 ? 1 : 0.3,
              color: 'hsl(var(--color-fg))',
              fontSize: 12,
              lineHeight: '16px',
            }}
          >
            &#9650;
          </button>
          <button
            onClick={onNext}
            disabled={matchCount === 0}
            aria-label="Next match"
            style={{
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              padding: '2px 1px',
              cursor: matchCount > 0 ? 'pointer' : 'default',
              opacity: matchCount > 0 ? 1 : 0.3,
              color: 'hsl(var(--color-fg))',
              fontSize: 12,
              lineHeight: '16px',
            }}
          >
            &#9660;
          </button>
        </span>

        {}
        <span
          aria-live="polite"
          aria-label={shortcutCue ? `${shortcutCue} search` : undefined}
          title={shortcutCue || undefined}
          style={{
            color:
              hasError || hasNoMatches ? 'hsl(var(--color-error))' : 'hsl(var(--color-fg-subtle))',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: shortcutCue ? 10 : 11,
            lineHeight: shortcutCue ? '10px' : 'normal',
            whiteSpace: shortcutCue ? 'normal' : 'nowrap',
            width: FIND_BAR_STATUS_WIDTH,
            minWidth: FIND_BAR_STATUS_WIDTH,
            maxWidth: FIND_BAR_STATUS_WIDTH,
            maxHeight: 22,
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {shortcutCue || counterText}
        </span>

        {}
        <button
          onClick={onClose}
          aria-label="Close find bar"
          style={{
            background: 'transparent',
            border: 'none',
            borderRadius: 4,
            padding: 0,
            width: FIND_BAR_CLOSE_WIDTH,
            height: 20,
            cursor: 'pointer',
            color: 'hsl(var(--color-fg))',
            fontSize: 14,
            lineHeight: '16px',
          }}
        >
          &#10005;
        </button>
      </div>

      {}
      {showDropdown && (
        <div
          ref={dropdownRef}
          data-testid="findbar-aa-dropdown"
          style={{
            background: 'hsl(var(--color-bg))',
            border: '1px solid hsl(var(--color-border))',
            borderTop: 'none',
            borderRadius: '0 0 6px 6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            width: FIND_BAR_WIDTH,
            maxWidth: '100%',
            boxSizing: 'border-box',
            maxHeight: 240,
            overflowY: 'auto',
            overflowX: 'hidden',
            fontSize: 12,
          }}
        >
          {matches.map((match, idx) => {
            const isActive = idx === activeIndex;
            const typeLabel = getMatchTypeLabel(match);
            const posLabel = formatMatchPositionLabelParts(match);
            const annotationBadgeStyle =
              match.type === 'annotation' ? resolveAnnotationBadgeStyle?.(match) : undefined;
            const annotationTrackLabel =
              (match.type === 'annotation' || match.type === 'protein') &&
              match.annotationTrackId &&
              match.annotationTrackId.trim().toLowerCase() !== typeLabel.trim().toLowerCase()
                ? match.annotationTrackId
                : null;
            const proteinGeneId = match.type === 'protein' ? match.protein?.geneId : undefined;
            const previousProteinGeneId =
              idx > 0 && matches[idx - 1]?.type === 'protein'
                ? matches[idx - 1]?.protein?.geneId
                : undefined;
            const startsProteinGeneGroup =
              match.type === 'protein' &&
              (idx === 0 ||
                matches[idx - 1]?.type !== 'protein' ||
                proteinGeneId !== previousProteinGeneId);

            return (
              <Fragment key={`${match.start}-${match.end}-${match.type}-${idx}`}>
                {startsProteinGeneGroup ? (
                  <div
                    data-testid="findbar-protein-gene-group"
                    style={{
                      padding: '5px 10px 3px',
                      color: 'hsl(var(--color-fg-muted))',
                      background: 'hsl(var(--color-bg-muted) / 0.55)',
                      borderBottom: '1px solid hsl(var(--color-border) / 0.3)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.025em',
                    }}
                  >
                    {proteinGeneId || 'Unassigned gene'}
                  </div>
                ) : null}
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onActivateMatch?.(idx)}
                  aria-current={isActive ? 'true' : undefined}
                  data-testid="findbar-aa-result-row"
                  data-match-index={idx}
                  data-match-type={match.type}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    maxWidth: '100%',
                    minWidth: 0,
                    boxSizing: 'border-box',
                    padding: '6px 10px',
                    border: 'none',
                    borderBottom: '1px solid hsl(var(--color-border) / 0.3)',
                    background: isActive ? 'hsl(var(--color-bg-muted))' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'hsl(var(--color-fg))',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                  }}
                >
                  {}
                  <span
                    title={typeLabel}
                    style={{
                      display: 'inline-block',
                      padding: '1px 5px',
                      borderRadius: 3,
                      fontSize: 10,
                      fontWeight: 600,
                      background: annotationBadgeStyle?.background ?? getMatchBadgeColor(match),
                      color: annotationBadgeStyle?.color ?? '#fff',
                      boxShadow: annotationBadgeStyle?.accent
                        ? `inset 0 -2px 0 ${annotationBadgeStyle.accent}`
                        : undefined,
                      flexShrink: 0,
                      minWidth: 48,
                      maxWidth: 96,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                    }}
                  >
                    {typeLabel}
                  </span>

                  {}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: match.label ? 500 : 400,
                    }}
                  >
                    {match.type === 'protein'
                      ? userEntityLabel(match.label ?? userEntityLabel(match.protein?.transcriptId))
                      : (match.label ?? 'Unknown')}
                  </span>

                  {annotationTrackLabel ? (
                    <span
                      title={`Annotation track: ${annotationTrackLabel}`}
                      style={{
                        color: 'hsl(var(--color-fg-subtle))',
                        fontSize: 10,
                        flexShrink: 0,
                        maxWidth: 72,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {annotationTrackLabel}
                    </span>
                  ) : null}

                  {match.annotationTrackVisibility === 'hidden' ? (
                    <span
                      data-testid="findbar-hidden-annotation-badge"
                      title="This annotation's track is currently hidden"
                      style={{
                        border: '1px solid hsl(var(--color-border))',
                        borderRadius: 999,
                        color: 'hsl(var(--color-fg-muted))',
                        fontSize: 9,
                        fontWeight: 600,
                        lineHeight: '14px',
                        padding: '0 5px',
                        flexShrink: 0,
                      }}
                    >
                      Hidden
                    </span>
                  ) : null}

                  {}
                  <span
                    style={{
                      color: 'hsl(var(--color-fg-subtle))',
                      fontSize: 11,
                      fontFamily: `'${JETBRAINS_MONO_FONT_NAME}', 'Roboto Mono', monospace`,
                      flexShrink: 0,
                    }}
                  >
                    {posLabel.start} <span style={{ fontWeight: 700 }}>{posLabel.glyph}</span>{' '}
                    {posLabel.end}
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getFindShortcutLabel(): string {
  return formatShortcut(['cmd', 'f']) ?? 'Ctrl+F';
}

function formatMatchPositionLabelParts(match: SearchMatch): {
  start: string;
  glyph: string;
  end: string;
} {
  const direction = match.annotation?.direction ?? (match.strand === 'reverse' ? -1 : 1);
  const glyph = direction === -1 ? '←' : direction === 1 ? '→' : '–';
  const start = match.localStart ?? match.start;
  const end = match.localEnd ?? match.end;
  return {
    start: `${match.chrom ? `${match.chrom}:` : ''}${start + 1}`,
    glyph,
    end: String(end + 1),
  };
}

function getMatchTypeLabel(match: SearchMatch): string {
  switch (match.type) {
    case 'nucleotide':
      return 'DNA';
    case 'protein':
      return 'Peptide';
    case 'annotation':
      return match.featureType?.trim() || match.annotation?.type?.trim() || 'Annotation';
    default:
      return 'Match';
  }
}

function getMatchBadgeColor(match: SearchMatch): string {
  switch (match.type) {
    case 'protein':
      return 'hsl(270, 50%, 50%)';
    case 'annotation':
      return 'hsl(180, 50%, 40%)';
    default:
      return 'hsl(220, 40%, 50%)';
  }
}
