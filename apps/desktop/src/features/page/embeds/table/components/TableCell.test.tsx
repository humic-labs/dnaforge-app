/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';

const { mockResolveProviderReference } = vi.hoisted(() => ({
  mockResolveProviderReference: vi.fn(),
}));

vi.mock('../../../../../platform', () => ({
  platform: () => ({
    benchlingMigration: { resolveProviderReference: mockResolveProviderReference },
  }),
}));

import { TableCell } from './TableCell';
import { __resetBenchlingLinkDestinationCacheForTests } from '../../../editor/benchling-external-link-marker';
import {
  __resetReferenceGenerationForTests,
  bumpReferenceGeneration,
} from '../../../entity-ref/reference-generation';
import type { Cell, CellPosition } from '../types';

const baseCell: Cell = { value: '', type: 'text' };
const pos: CellPosition = { row: 0, col: 0 };

beforeEach(() => {
  mockResolveProviderReference.mockReset();
  __resetBenchlingLinkDestinationCacheForTests();
  __resetReferenceGenerationForTests();
});

it.each([false, true])(
  'explains a saved result without replacing its value (stale: %s)',
  (stale) => {
    const saved = {
      value: '42',
      type: 'text' as const,
      sourceFormula: '=BENCHLING(A1)',
      sourceRenderedValue: '42',
      formulaCompatibility: 'unsupported' as const,
      stale,
    };
    render(
      <TableCell
        cell={saved}
        position={pos}
        isFocused={false}
        isEditing={false}
        editingValue=""
        onCellClick={() => {}}
        onCellDoubleClick={() => {}}
        onEditingValueChange={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        cellRef={() => {}}
      />
    );
    expect(screen.getByText('42')).toBeInTheDocument();
    const indicator = screen.getByRole('img', {
      name: new RegExp(stale ? '^May be outdated' : '^Saved result'),
    });
    expect(indicator).toHaveTextContent(stale ? 'May be outdated' : 'Saved');
    expect(indicator).toHaveClass('whitespace-normal', 'break-words');
    expect(indicator).not.toHaveClass('break-all');
    expect(indicator).not.toHaveClass('absolute');
    expect(indicator).toHaveAttribute('title', expect.stringContaining('=BENCHLING(A1)'));
    expect(indicator).toHaveAttribute('title', expect.stringContaining('does not recalculate'));
  }
);

it('shows saved provenance instead of the ordinary formula corner', () => {
  const formula = '=BENCHLING_ONLY(A1)';
  render(
    <TableCell
      cell={{
        value: formula,
        type: 'formula',
        computed: 42,
        formulaCompatibility: 'unsupported',
      }}
      position={pos}
      isFocused={false}
      isEditing={false}
      editingValue=""
      onCellClick={() => {}}
      onCellDoubleClick={() => {}}
      onEditingValueChange={() => {}}
      onEditCommit={() => {}}
      onEditCancel={() => {}}
      cellRef={() => {}}
    />
  );

  expect(screen.getByRole('img', { name: /^Saved result/ })).toHaveTextContent('Saved');
  expect(document.querySelector(`[title="Formula: ${formula}"]`)).not.toBeInTheDocument();
});

interface RenderOpts {
  editingValue: string;
}

function renderEditingCell({ editingValue }: RenderOpts) {
  const onEditingValueChange = vi.fn();
  const onEditCommit = vi.fn();
  const onEditCancel = vi.fn();
  const editInputRef = createRef<HTMLInputElement>();

  render(
    <TableCell
      cell={baseCell}
      position={pos}
      isFocused={true}
      isEditing={true}
      editingValue={editingValue}
      editInputRef={editInputRef}
      onCellClick={() => {}}
      onCellDoubleClick={() => {}}
      onEditingValueChange={onEditingValueChange}
      onEditCommit={onEditCommit}
      onEditCancel={onEditCancel}
      cellRef={() => {}}
    />
  );

  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { input, onEditingValueChange, onEditCommit, onEditCancel };
}

describe('TableCell — autocomplete open with matches (=su)', () => {
  it('Tab inserts =SUM( and does not commit the cell', () => {
    const { input, onEditingValueChange, onEditCommit } = renderEditingCell({
      editingValue: '=su',
    });

    fireEvent.keyDown(input, { key: 'Tab' });

    expect(onEditingValueChange).toHaveBeenCalledWith('=SUM(', '=SUM('.length);
    expect(onEditCommit).not.toHaveBeenCalled();
  });

  it('Enter inserts =SUM( and does not commit the cell', () => {
    const { input, onEditingValueChange, onEditCommit } = renderEditingCell({
      editingValue: '=su',
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onEditingValueChange).toHaveBeenCalledWith('=SUM(', '=SUM('.length);
    expect(onEditCommit).not.toHaveBeenCalled();
  });

  it('ArrowDown moves selection without committing', () => {
    const { input, onEditingValueChange, onEditCommit } = renderEditingCell({
      editingValue: '=I',
    });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onEditCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEditingValueChange).toHaveBeenCalled();
    const inserted = onEditingValueChange.mock.calls[0][0] as string;
    expect(inserted).toMatch(/^=[A-Z]+\($/);
    expect(inserted).not.toBe('=IF(');
    expect(onEditCommit).not.toHaveBeenCalled();
  });

  it('ArrowUp moves selection without committing (regression — symmetry)', () => {
    const { input, onEditCommit } = renderEditingCell({ editingValue: '=I' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEditCommit).not.toHaveBeenCalled();
  });

  it('Escape with autocomplete open dismisses the dropdown only (preserves two-press convention)', () => {
    const { input, onEditCancel } = renderEditingCell({ editingValue: '=su' });

    expect(document.querySelector('.formula-autocomplete-dropdown')).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onEditCancel).not.toHaveBeenCalled();
    expect(document.querySelector('.formula-autocomplete-dropdown')).toBeNull();
  });

  it('IME composition: Tab is ignored (native behavior preserved)', () => {
    const { input, onEditingValueChange, onEditCommit } = renderEditingCell({
      editingValue: '=su',
    });

    fireEvent.keyDown(input, { key: 'Tab', isComposing: true });

    expect(onEditingValueChange).not.toHaveBeenCalled();
    expect(onEditCommit).not.toHaveBeenCalled();
  });
});

describe('TableCell — autocomplete open with empty filter (=xyz)', () => {
  it('Tab falls through to commit-and-move-right', () => {
    const { input, onEditCommit, onEditingValueChange } = renderEditingCell({
      editingValue: '=xyz',
    });

    fireEvent.keyDown(input, { key: 'Tab' });

    expect(onEditCommit).toHaveBeenCalledWith('right');
    expect(onEditingValueChange).not.toHaveBeenCalled();
  });

  it('Enter falls through to commit-and-move-down', () => {
    const { input, onEditCommit, onEditingValueChange } = renderEditingCell({
      editingValue: '=xyz',
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onEditCommit).toHaveBeenCalledWith('down');
    expect(onEditingValueChange).not.toHaveBeenCalled();
  });
});

describe('TableCell — autocomplete closed (regression)', () => {
  it('Tab commits and moves right', () => {
    const { input, onEditCommit } = renderEditingCell({ editingValue: 'hello' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onEditCommit).toHaveBeenCalledWith('right');
  });

  it('Enter commits and moves down', () => {
    const { input, onEditCommit } = renderEditingCell({ editingValue: 'hello' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEditCommit).toHaveBeenCalledWith('down');
  });

  it('Escape cancels the edit', () => {
    const { input, onEditCancel } = renderEditingCell({ editingValue: 'hello' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEditCancel).toHaveBeenCalled();
  });
});

describe('TableCell — persisted formatting', () => {
  it('leaves a stored background fill to the enclosing grid cell', () => {
    const { container } = render(
      <TableCell
        cell={{ ...baseCell, value: 'filled', format: { bgColor: '#ffcc00' } }}
        position={pos}
        isFocused={false}
        isEditing={false}
        editingValue=""
        onCellClick={() => {}}
        onCellDoubleClick={() => {}}
        onEditingValueChange={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        cellRef={() => {}}
      />
    );

    expect(container.querySelector('[data-cell-position="0,0"]')).not.toHaveStyle({
      backgroundColor: '#ffcc00',
    });
  });
});

describe('TableCell — native workspace reference', () => {
  it('dispatches the ordinary entity-open event with the owning workspace root', () => {
    const opened = vi.fn();
    window.addEventListener('waypoint:open-entity', opened, { once: true });
    render(
      <TableCell
        cell={{
          value: 'PCR protocol',
          type: 'text',
          reference: { kind: 'native-entity', entityId: 'protocol-pcr' },
        }}
        position={pos}
        isFocused={false}
        isEditing={false}
        editingValue=""
        referenceWorkspaceRoot="/lab"
        onCellClick={() => {}}
        onCellDoubleClick={() => {}}
        onEditingValueChange={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        cellRef={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: 'Open PCR protocol in DNAForge' }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      entityType: 'native-catalog',
      entityId: 'protocol-pcr',
      label: 'PCR protocol',
      owningRoot: '/lab',
    });
  });

  it('opens a legacy migration destination as the same native workspace entity', () => {
    const opened = vi.fn();
    window.addEventListener('waypoint:open-entity', opened, { once: true });
    render(
      <TableCell
        cell={{
          value: 'Legacy PCR protocol',
          type: 'text',
          reference: {
            kind: 'migration-destination',
            destinationTargetId: 'protocol-pcr',
          },
        }}
        position={pos}
        isFocused={false}
        isEditing={false}
        editingValue=""
        referenceWorkspaceRoot="/lab"
        onCellClick={() => {}}
        onCellDoubleClick={() => {}}
        onEditingValueChange={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        cellRef={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: 'Open Legacy PCR protocol in DNAForge' }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      entityType: 'native-catalog',
      entityId: 'protocol-pcr',
      label: 'Legacy PCR protocol',
      owningRoot: '/lab',
    });
  });
});

describe('TableCell — external Benchling destination', () => {
  const benchlingCell: Cell = {
    value: 'pDEMO666',
    type: 'text',
    reference: {
      kind: 'external-url',
      href: 'https://benchling.com/examplelab/f/lib_DemoLib1-registry/seq_DemoSeq1-pdemo666/edit',
    },
  };

  function renderReferenceCell(referenceWorkspaceRoot?: string) {
    return render(
      <TableCell
        cell={benchlingCell}
        position={pos}
        isFocused={false}
        isEditing={false}
        editingValue=""
        referenceWorkspaceRoot={referenceWorkspaceRoot}
        onCellClick={() => {}}
        onCellDoubleClick={() => {}}
        onEditingValueChange={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        cellRef={() => {}}
      />
    );
  }

  it('marks a table link when the object is not imported', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: { status: 'pending', reason: 'target_not_imported' },
      target: null,
    });
    renderReferenceCell('/lab/caspian');

    const link = screen.getByRole('link');
    await waitFor(() =>
      expect(link.getAttribute('data-benchling-link-destination')).toBe('external')
    );
    expect(link.getAttribute('data-benchling-link-marker')).toBe('B↗');
    expect(link.getAttribute('aria-label')).toBe('pDEMO666, opens in Benchling');
    expect(link.getAttribute('title')).toBe('Opens in Benchling');
  });

  it('leaves a table link unmarked when it resolves inside DNAForge', async () => {
    mockResolveProviderReference.mockResolvedValue({
      resolution: {
        status: 'resolved',
        entityId: 'caspian::sequence-pdemo666',
        scope: 'workspace',
        evidence: 'stable_id',
      },
      target: null,
    });
    renderReferenceCell('/lab/caspian');

    const link = screen.getByRole('link');
    await waitFor(() => expect(link.getAttribute('aria-label')).toContain('in DNAForge'));
    expect(link.getAttribute('data-benchling-link-destination')).toBe('native');
    expect(link.hasAttribute('data-benchling-link-marker')).toBe(false);
  });

  it('marks a Benchling link without an owning workspace and skips IPC', async () => {
    renderReferenceCell();

    const link = screen.getByRole('link');
    await waitFor(() =>
      expect(link.getAttribute('data-benchling-link-destination')).toBe('external')
    );
    expect(mockResolveProviderReference).not.toHaveBeenCalled();
  });

  it('removes the Benchling marker after a later import resolves the target locally', async () => {
    mockResolveProviderReference
      .mockResolvedValueOnce({
        resolution: { status: 'pending', reason: 'target_not_imported' },
        target: null,
      })
      .mockResolvedValueOnce({
        resolution: {
          status: 'resolved',
          entityId: 'caspian::sequence-pdemo666',
          scope: 'workspace',
          evidence: 'stable_id',
        },
        target: null,
      });
    renderReferenceCell('/lab/caspian');

    const link = screen.getByRole('link');
    await waitFor(() =>
      expect(link.getAttribute('data-benchling-link-destination')).toBe('external')
    );

    act(() => bumpReferenceGeneration());

    await waitFor(() =>
      expect(link.getAttribute('data-benchling-link-destination')).toBe('native')
    );
    expect(link.hasAttribute('data-benchling-link-marker')).toBe(false);
    expect(mockResolveProviderReference).toHaveBeenCalledTimes(2);
  });
});

describe('TableCell — edit input height ()', () => {
  it('does not give the edit input a full height, so the value stays put when editing starts', () => {
    const { input } = renderEditingCell({ editingValue: 'abc' });
    const heightClasses = input.className.split(/\s+/).filter((token) => token.startsWith('h-'));
    expect(
      heightClasses,
      'The edit input must not declare a height (). It fills the width of the ' +
        'cell but must stay one line tall: the wrapper around it now fills the whole ' +
        'table cell, so a height here stretches the input over the entire cell. A ' +
        'browser then centres the input text while the displayed text is top-aligned, ' +
        'which makes the value visibly jump when editing starts and drags the formula ' +
        'suggestion list away from the caret.'
    ).toEqual([]);
  });
});
