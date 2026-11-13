import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiffResult } from '../diff/sequence-diff';
import { SequenceChangeList } from './SequenceChangeList';
import { GitHistoryDrawer } from './GitHistoryDrawer';

const diff: DiffResult = {
  changes: [
    { type: 'mutation', position: 12, length: 1, oldBases: 'A', newBases: 'G' },
    { type: 'deletion', position: 5, oldPosition: 5, length: 2, oldBases: 'CC' },
    { type: 'insertion', position: 5, length: 3, newBases: 'AGT' },
  ],
  insertions: 1,
  deletions: 1,
  mutations: 1,
  insertedBp: 3,
  deletedBp: 2,
};

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (originalScrollIntoView)
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  else delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('SequenceChangeList', () => {
  it('retains the existing table and navigates both changes at one position only while focused', () => {
    const onScrollToChange = vi.fn();
    render(<SequenceChangeList diffResult={diff} onScrollToChange={onScrollToChange} />);
    expect(screen.getByText('Changes (3)')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
    expect(screen.getByText('1 sub')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Type',
      'Pos',
      'Len',
      'Bases',
    ]);
    expect(screen.getByText('A→G')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onScrollToChange).not.toHaveBeenCalled();
    const list = screen.getByRole('region', { name: 'Sequence changes' });
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onScrollToChange.mock.calls).toEqual([
      [diff.changes[1], 1],
      [diff.changes[2], 2],
      [diff.changes[0], 0],
    ]);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(onScrollToChange).toHaveBeenLastCalledWith(diff.changes[2], 2);
    fireEvent.keyDown(list, { key: 'ArrowDown', metaKey: true });
    expect(onScrollToChange).toHaveBeenCalledTimes(4);
  });

  it('uses supplied coordinate descriptions and resets selection when the comparison changes', () => {
    const onScrollToChange = vi.fn();
    const onToggleDiffView = vi.fn();
    const props = {
      diffResult: diff,
      onScrollToChange,
      positionLabel: 'Reference → result',
      renderPosition: (_change: DiffResult['changes'][number], index: number) => `Range ${index}`,
      describeChange: (_change: DiffResult['changes'][number], index: number) =>
        `Reference range ${index}; predicted result range ${index}`,
      isDiffViewActive: true,
      onToggleDiffView,
    };
    const { rerender } = render(<SequenceChangeList {...props} />);
    expect(screen.getByRole('columnheader', { name: 'Reference → result' })).toBeInTheDocument();
    const insertion = screen.getByRole('row', {
      name: 'Reference range 2; predicted result range 2',
    });
    fireEvent.click(within(insertion).getByText('Range 2'));
    expect(onScrollToChange).toHaveBeenLastCalledWith(diff.changes[2], 2);
    expect(insertion).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide diff view' }));
    expect(onToggleDiffView).toHaveBeenCalledOnce();
    const replacement = { ...diff, changes: [diff.changes[0]] };
    rerender(<SequenceChangeList {...props} diffResult={replacement} />);
    expect(screen.queryByRole('row', { selected: true })).not.toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Sequence changes' });
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(onScrollToChange).toHaveBeenLastCalledWith(replacement.changes[0], 0);
    rerender(<SequenceChangeList {...props} diffResult={{ ...replacement, changes: [] }} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps Git actions in their drawer while using the shared table callbacks', () => {
    const onScrollToChange = vi.fn();
    const onToggleDiffView = vi.fn();
    render(
      <GitHistoryDrawer
        log={[]}
        isLoading={false}
        isGitRepo
        selectedCommitHash={null}
        hasUncommittedChanges
        diffResult={diff}
        onScrollToChange={onScrollToChange}
        isDiffViewActive={false}
        onToggleDiffView={onToggleDiffView}
        onSelectCommit={vi.fn()}
        onCommit={vi.fn(async () => {})}
        onRevert={vi.fn(async () => {})}
      />
    );
    expect(screen.getByRole('button', { name: 'Commit this file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('AGT'));
    expect(onScrollToChange).toHaveBeenCalledWith(diff.changes[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Show diff view' }));
    expect(onToggleDiffView).toHaveBeenCalledOnce();
  });
});
