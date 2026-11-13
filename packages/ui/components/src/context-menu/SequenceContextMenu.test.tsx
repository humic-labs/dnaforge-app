// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SequenceContextMenu } from './SequenceContextMenu';
import type { Annotation } from '@waypoint/sequence-utils';

const ASK_AI_LABEL = 'Ask Agent';

const CLICKED_CDS: Annotation = {
  name: 'GFP',
  type: 'CDS',
  start: 1,
  end: 9,
  direction: 1,
};

afterEach(cleanup);

describe('SequenceContextMenu — "Ask AI about this selection" is selection-gated ', () => {
  it('shows caller-bound shortcut hints without changing action names or callbacks', () => {
    const invert = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        hasSelection
        onCopySequence={vi.fn()}
        onCopyReverseComplement={vi.fn()}
        onCopyTranslation={vi.fn()}
        onInvertSelection={invert}
        onAttachPrimers={vi.fn()}
        shortcutHints={{
          copySequence: 'Ctrl+C',
          copyReverseComplement: 'Ctrl+Alt+Shift+R',
          copyTranslation: 'Ctrl+Shift+C',
          invertSelection: 'Ctrl+Shift+I',
        }}
      />
    );
    for (const [label, hint] of [
      ['Copy Sequence', 'Ctrl+C'],
      ['Copy Sequence (Reverse Complement)', 'Ctrl+Alt+Shift+R'],
      ['Copy Translation', 'Ctrl+Shift+C'],
      ['Select inverse', 'Ctrl+Shift+I'],
    ]) {
      const item = screen.getByRole('button', { name: label });
      expect(
        item.querySelector('[data-testid="sequence-context-menu-shortcut"]')?.textContent
      ).toBe(hint);
    }
    expect(
      screen.getByRole('button', { name: 'Attach Primers' }).querySelector('[data-shortcut-column]')
    ).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Select inverse' }));
    expect(invert).toHaveBeenCalledOnce();
  });

  it('EMPTY/caret selection: the Ask AI item is ABSENT and the hint shows (no whole-entity fallback)', () => {
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        hasSelection={false}
        onAskAI={vi.fn()}
      />
    );

    expect(screen.queryByText(ASK_AI_LABEL)).toBeNull();

    expect(screen.getByText('Select sequence first')).toBeTruthy();
  });

  it('providing onAskAI does NOT force the item on when there is no selection', () => {
    const onAskAI = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        hasSelection={false}
        onAskAI={onAskAI}
      />
    );
    expect(screen.queryByText(ASK_AI_LABEL)).toBeNull();
    expect(onAskAI).not.toHaveBeenCalled();
  });

  it('CONTRAST — with a real selection the Ask AI item IS offered (with a `/` cue)', () => {
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        hasSelection
        onAskAI={vi.fn()}
        askAiShortcut="/"
      />
    );
    expect(screen.getByText(ASK_AI_LABEL)).toBeTruthy();
    const shortcut = screen.getByTestId('sequence-context-menu-shortcut');
    expect(shortcut.textContent).toBe('/');
    expect(screen.queryByText('Select sequence first')).toBeNull();
  });

  it('omits the `/` cue when the caller does not pass askAiShortcut (`/` disabled)', () => {
    render(
      <SequenceContextMenu x={10} y={10} isOpen onClose={() => {}} hasSelection onAskAI={vi.fn()} />
    );
    expect(screen.getByText(ASK_AI_LABEL)).toBeTruthy();
    expect(screen.queryByTestId('sequence-context-menu-shortcut')).toBeNull();
  });

  it('Copy Sequence renders an OS-sensitive shortcut cue via the canonical layer', () => {
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        hasSelection
        onCopySequence={vi.fn()}
      />
    );
    expect(screen.getByText('Copy Sequence')).toBeTruthy();
    const cue = screen.getByTestId('sequence-context-menu-shortcut').textContent;
    expect(['⌘C', 'Ctrl+C']).toContain(cue);
  });
});

describe('SequenceContextMenu — "Create amino acid sequence" ', () => {
  it('is absent without a clicked CDS, even if the callback is wired', () => {
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        onCreateAminoAcidSequence={vi.fn()}
      />
    );
    expect(screen.queryByText('Create amino acid sequence')).toBeNull();
  });

  it('renders enabled for a valid CDS and invokes the callback on click', () => {
    const onCreate = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        clickedCDS={CLICKED_CDS}
        onCreateAminoAcidSequence={onCreate}
      />
    );
    const item = screen.getByText('Create amino acid sequence');
    expect(item).toBeTruthy();
    expect(screen.queryByTestId('create-amino-acid-sequence-disabled')).toBeNull();
    const button = item.closest('button');
    expect(button).toBeTruthy();
    fireEvent.mouseDown(button!);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders disabled with a hint when the CDS has no valid translation', () => {
    const onCreate = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        clickedCDS={CLICKED_CDS}
        onCreateAminoAcidSequence={onCreate}
        createAminoAcidSequenceDisabled
      />
    );
    const disabled = screen.getByTestId('create-amino-acid-sequence-disabled');
    expect(disabled).toBeTruthy();
    expect(disabled.textContent).toContain('Create amino acid sequence');
    disabled.click();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('SequenceContextMenu — transcript sequence actions', () => {
  it('offers DNA, RNA, and isoform choice only for a clicked transcript', () => {
    const onCopyDna = vi.fn();
    const onCopyRna = vi.fn();
    const onChooseIsoform = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        clickedTranscript={{ name: 'Transcript 1' }}
        onCopyTranscriptDna={onCopyDna}
        onCopyTranscriptRna={onCopyRna}
        onChooseTranscriptIsoform={onChooseIsoform}
      />
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: /Copy transcript DNA/ }));
    fireEvent.mouseDown(screen.getByRole('button', { name: /Copy transcript RNA/ }));
    fireEvent.mouseDown(screen.getByRole('button', { name: /Choose isoform/ }));
    expect(onCopyDna).toHaveBeenCalledTimes(1);
    expect(onCopyRna).toHaveBeenCalledTimes(1);
    expect(onChooseIsoform).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Select sequence first')).toBeNull();
  });

  it('does not expose transcript actions when no transcript was clicked', () => {
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        onCopyTranscriptDna={vi.fn()}
        onCopyTranscriptRna={vi.fn()}
        onChooseTranscriptIsoform={vi.fn()}
      />
    );

    expect(screen.queryByText('Copy transcript DNA')).toBeNull();
    expect(screen.queryByText('Copy transcript RNA')).toBeNull();
    expect(screen.queryByText('Choose isoform…')).toBeNull();
  });
});

describe('SequenceContextMenu — primer copy and edit actions', () => {
  const clickedPrimer = {
    id: 'primer-1',
    name: 'Modified primer',
    start: 4,
    end: 24,
    direction: 'forward',
  };

  it('keeps Copy Sequence and Copy bases but suppresses Structure for a primer over a CDS', () => {
    const onClose = vi.fn();
    const onCopyBases = vi.fn();
    const { rerender } = render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={onClose}
        clickedPrimer={clickedPrimer}
        onCopyPrimerBases={onCopyBases}
        hasSelection
        onCopySequence={vi.fn()}
        clickedCDS={CLICKED_CDS}
        structureAnnotation={CLICKED_CDS}
        onViewStructure={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Copy bases' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Sequence' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy for IDT' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^View Structure/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy$/ })).toBeNull();
    expect(screen.queryByText('Copy Special')).toBeNull();
    expect(screen.queryByText('Natural DNA')).toBeNull();
    onClose.mockClear();
    rerender(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={onClose}
        clickedPrimer={clickedPrimer}
        onCopyPrimerBases={onCopyBases}
      />
    );
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Copy bases' }));
    expect(onCopyBases).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('separates binding-site editing from opening the shared primer', () => {
    const onEditPrimer = vi.fn();
    const onEditPrimerBinding = vi.fn();
    render(
      <SequenceContextMenu
        x={10}
        y={10}
        isOpen
        onClose={() => {}}
        clickedPrimer={clickedPrimer}
        onEditPrimer={onEditPrimer}
        onEditPrimerBinding={onEditPrimerBinding}
        onCopyPrimerBases={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: /Edit binding site/ }));
    expect(onEditPrimerBinding).toHaveBeenCalledTimes(1);
    expect(onEditPrimer).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('button', { name: /Open primer/ }));
    expect(onEditPrimer).toHaveBeenCalledTimes(1);
  });
});
