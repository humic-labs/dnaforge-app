import { safeFocus } from '../../../shared/utils/safeFocus';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHANGE_COLORS } from '@waypoint/workspace-editor';
import type { DiffResult, SequenceChange } from '../diff/sequence-diff';

const CHANGE_TYPE_META: Record<SequenceChange['type'], { color: string; shortLabel: string }> = {
  insertion: { color: CHANGE_COLORS.insertion.accent, shortLabel: 'INS' },
  deletion: { color: CHANGE_COLORS.deletion.accent, shortLabel: 'DEL' },
  mutation: { color: CHANGE_COLORS.substitution.accent, shortLabel: 'SUB' },
};

export interface SequenceChangeListProps {
  diffResult: DiffResult;

  onScrollToChange: (change: SequenceChange, index: number) => void;
  renderPosition?: (change: SequenceChange, index: number) => ReactNode;
  positionLabel?: ReactNode;

  describeChange?: (change: SequenceChange, index: number) => string;
  isDiffViewActive?: boolean;
  onToggleDiffView?: () => void;
}

export function SequenceChangeList({
  diffResult,
  onScrollToChange,
  renderPosition,
  positionLabel = 'Pos',
  describeChange,
  isDiffViewActive = false,
  onToggleDiffView,
}: SequenceChangeListProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const sortedChanges = useMemo(
    () =>
      diffResult.changes
        .map((change, index) => ({ change, index }))
        .sort((a, b) => a.change.position - b.change.position || a.index - b.index),
    [diffResult]
  );
  const [selection, setSelection] = useState<{ diff: DiffResult; row: number } | null>(null);

  const selectedChangeIdx =
    selection?.diff === diffResult && selection.row < sortedChanges.length ? selection.row : null;

  const navigateToChange = useCallback(
    (row: number) => {
      const entry = sortedChanges[row];
      if (!entry) return;
      setSelection({ diff: diffResult, row });
      onScrollToChange(entry.change, entry.index);
    },
    [sortedChanges, diffResult, onScrollToChange]
  );

  useEffect(() => {
    if (selectedChangeIdx === null) return;
    tableRef.current
      ?.querySelector(`[data-change-idx="${selectedChangeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedChangeIdx]);

  if (sortedChanges.length === 0) return null;

  return (
    <div className="border-b border-border">
      <div className="px-3 py-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-fg">Changes ({sortedChanges.length})</span>
        <span className="text-[10px] text-fg-muted">
          {diffResult.insertions > 0 && (
            <span style={{ color: CHANGE_COLORS.insertion.accent }}>+{diffResult.insertedBp}</span>
          )}
          {diffResult.insertions > 0 && diffResult.deletions > 0 && ' '}
          {diffResult.deletions > 0 && (
            <span style={{ color: CHANGE_COLORS.deletion.accent }}>-{diffResult.deletedBp}</span>
          )}
          {(diffResult.insertions > 0 || diffResult.deletions > 0) &&
            diffResult.mutations > 0 &&
            ' '}
          {diffResult.mutations > 0 && (
            <span style={{ color: CHANGE_COLORS.substitution.accent }}>
              {diffResult.mutations} sub
            </span>
          )}
        </span>
      </div>
      <div
        ref={tableRef}
        role="region"
        aria-label="Sequence changes"
        tabIndex={0}
        className="max-h-[200px] overflow-y-auto outline-none"
        onKeyDown={(event) => {
          if (event.metaKey || !event.currentTarget.contains(document.activeElement)) return;
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          event.stopPropagation();
          navigateToChange(
            event.key === 'ArrowDown'
              ? selectedChangeIdx === null
                ? 0
                : Math.min(selectedChangeIdx + 1, sortedChanges.length - 1)
              : selectedChangeIdx === null
                ? sortedChanges.length - 1
                : Math.max(selectedChangeIdx - 1, 0)
          );
        }}
      >
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-fg-muted text-left">
              <th className="pl-3 pr-1 py-0.5 font-medium">Type</th>
              <th className="px-1 py-0.5 font-medium">{positionLabel}</th>
              <th className="px-1 py-0.5 font-medium">Len</th>
              <th className="pl-1 pr-3 py-0.5 font-medium">Bases</th>
            </tr>
          </thead>
          <tbody>
            {sortedChanges.map(({ change, index }, row) => {
              const meta = CHANGE_TYPE_META[change.type];
              const description = describeChange?.(change, index);
              return (
                <tr
                  key={`${change.type}-${change.position}-${index}`}
                  data-change-idx={row}
                  aria-label={description}
                  aria-selected={selectedChangeIdx === row}
                  title={description}
                  className={`cursor-pointer hover:bg-accent/5 ${selectedChangeIdx === row ? 'bg-accent/10' : ''}`}
                  onClick={() => {
                    safeFocus(tableRef.current);
                    navigateToChange(row);
                  }}
                >
                  <td className="pl-3 pr-1 py-1">
                    <span className="flex items-center gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: meta.color }}
                      />
                      <span style={{ color: meta.color }}>{meta.shortLabel}</span>
                    </span>
                  </td>
                  <td className="px-1 py-1 text-fg-muted tabular-nums">
                    {renderPosition ? renderPosition(change, index) : change.position + 1}
                  </td>
                  <td className="px-1 py-1 text-fg-muted tabular-nums">{change.length}</td>
                  <td className="pl-1 pr-3 py-1 text-fg-muted font-mono truncate max-w-[80px]">
                    {change.type === 'mutation' && change.oldBases && change.newBases
                      ? `${change.oldBases}→${change.newBases}`
                      : change.type === 'insertion'
                        ? (change.newBases ?? '')
                        : change.type === 'deletion'
                          ? (change.oldBases ?? '')
                          : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 flex items-center justify-between border-t border-border/50">
        <span className="text-[10px] text-fg-muted">↑↓ to navigate</span>
        {onToggleDiffView && (
          <button
            onClick={onToggleDiffView}
            className={`text-[10px] px-2 py-0.5 rounded ${
              isDiffViewActive
                ? 'bg-accent/20 text-accent'
                : 'text-fg-muted hover:text-accent hover:bg-accent/10'
            }`}
          >
            {isDiffViewActive ? 'Hide diff view' : 'Show diff view'}
          </button>
        )}
      </div>
    </div>
  );
}
