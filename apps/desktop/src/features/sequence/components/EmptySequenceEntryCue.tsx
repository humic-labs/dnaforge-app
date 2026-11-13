import type { CSSProperties } from 'react';
import type { EmptySequenceEntryCue as EmptySequenceEntryCueVariant } from '../empty-sequence-entry-store';

interface EmptySequenceEntryCueProps {
  variant: EmptySequenceEntryCueVariant;
  marginLeft: number;
  rowHeight: number;
}

const FIRST_SEQUENCE_ROW_TOP = 32;

export function EmptySequenceEntryCue({
  variant,
  marginLeft,
  rowHeight,
}: EmptySequenceEntryCueProps) {
  const cueStyle = {
    '--empty-sequence-margin-left': `${marginLeft}px`,
    '--empty-sequence-row-height': `${rowHeight}px`,
    '--empty-sequence-first-row-top': `${FIRST_SEQUENCE_ROW_TOP}px`,
  } as CSSProperties;

  return (
    <div
      className="empty-sequence-entry-cue"
      data-testid="empty-sequence-entry-cue"
      data-variant={variant}
      role="note"
      aria-label="Empty DNA sequence. Start typing to add bases."
      style={cueStyle}
    >
      {variant === 'rows' ? (
        <div className="empty-sequence-entry-rows" data-testid="empty-sequence-entry-rows">
          <div className="empty-sequence-entry-row" data-row="active" />
          <div className="empty-sequence-entry-row" data-row="secondary" />
        </div>
      ) : null}

      <span className="empty-sequence-entry-caret" data-testid="empty-sequence-entry-caret" />

      {variant === 'hint' ? (
        <span className="empty-sequence-entry-hint" data-testid="empty-sequence-entry-hint">
          Start typing
        </span>
      ) : null}
    </div>
  );
}
