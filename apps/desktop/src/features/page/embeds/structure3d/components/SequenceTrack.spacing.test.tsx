// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  areSequenceTrackPropsEqual,
  SequenceTrack,
  type SequenceTrackProps,
} from './SequenceTrack';
import type { ChainSequence, ResidueInteractionState } from '../types';
import { HIGHLIGHT_COLORS } from '../types';

const CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: 'MTEYK',
  residues: [
    { position: 1, name: 'M', name3: 'MET' },
    { position: 2, name: 'T', name3: 'THR' },
    { position: 3, name: 'E', name3: 'GLU' },
    { position: 4, name: 'Y', name3: 'TYR' },
    { position: 5, name: 'K', name3: 'LYS' },
  ],
};

const INTERACTION_STATE: ResidueInteractionState = {
  hovered: null,
  selected: [],
};

describe('SequenceTrack spacing', () => {
  it('separates plain, Shift-range, and platform-additive residue gestures', () => {
    const onSelect = vi.fn();
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByTestId('residue-A-1'));
    fireEvent.click(screen.getByTestId('residue-A-3'), { shiftKey: true });
    fireEvent.click(screen.getByTestId('residue-A-5'), { metaKey: true });
    fireEvent.click(screen.getByTestId('residue-A-2'), { ctrlKey: true });

    const orderedResidues = CHAIN.residues.map((residue) =>
      expect.objectContaining({
        chain: 'A',
        position: residue.position,
        labelCompId: residue.name3,
      })
    );
    expect(onSelect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ chain: 'A', position: 1, labelCompId: 'MET' }),
      'replace',
      orderedResidues
    );
    expect(onSelect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chain: 'A', position: 3, labelCompId: 'GLU' }),
      'range',
      orderedResidues
    );
    expect(onSelect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ chain: 'A', position: 5, labelCompId: 'LYS' }),
      'toggle',
      orderedResidues
    );
    expect(onSelect).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ chain: 'A', position: 2, labelCompId: 'THR' }),
      'toggle',
      orderedResidues
    );
  });

  it('stacks the chain header above a full-width wrapping amino-acid sequence', () => {
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const chainSequence = screen.getByTestId('chain-sequence');
    const chainTrack = chainSequence.parentElement as HTMLElement;

    const chainHeader = screen.getByTestId('chain-header');

    expect(chainSequence).toHaveClass('flex');
    expect(chainSequence).toHaveClass('flex-wrap');
    expect(chainSequence).toHaveClass('content-start');
    expect(chainSequence).toHaveClass('gap-x-0');
    expect(chainSequence).toHaveClass('gap-y-2.5');
    expect(chainSequence).toHaveClass('px-2.5');
    expect(chainSequence).toHaveClass('pt-2.5');
    expect(chainSequence).toHaveClass('pb-1.5');
    expect(chainSequence).not.toHaveClass('overflow-x-auto');
    expect(chainSequence).not.toHaveClass('gap-px');
    expect(screen.getByTestId('residue-A-1')).toHaveClass('scroll-mt-8');

    expect(chainHeader).toHaveClass('px-2.5');
    expect(chainHeader).toHaveClass('py-1');
    expect(chainHeader).toHaveClass('items-center');
    expect(chainHeader).toHaveClass('sticky');
    expect(chainHeader).toHaveClass('top-0');
    expect(chainHeader).toHaveClass('z-20');
    expect(chainHeader).toHaveClass('bg-bg-subtle');
    expect(chainHeader).not.toHaveClass('border-b');
    expect(screen.getByText('1')).toHaveStyle({ top: '-7px' });

    expect(chainTrack).toHaveClass('flex');
    expect(chainTrack).toHaveClass('flex-col');
    expect(chainTrack).not.toHaveClass('grid');
    expect(chainTrack).not.toHaveClass('grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]');
  });

  it('collapses to a one-line, name-only header that hides the sequence', () => {
    const { rerender } = render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        collapsed={false}
      />
    );

    expect(screen.getByTestId('chain-sequence')).toBeInTheDocument();
    expect(screen.getByTestId('residue-A-1')).toBeInTheDocument();
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-collapsed', 'expanded');
    const toggle = screen.getByTestId('chain-collapse-toggle-A');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        collapsed
      />
    );

    expect(screen.queryByTestId('chain-sequence')).not.toBeInTheDocument();
    expect(screen.queryByTestId('residue-A-1')).not.toBeInTheDocument();
    expect(screen.getByText('Chain A')).toBeInTheDocument();
    expect(screen.getByTestId('chain-track-A')).toHaveAttribute('data-collapsed', 'collapsed');
    expect(screen.getByTestId('chain-collapse-toggle-A')).toHaveAttribute('aria-expanded', 'false');
  });

  it('invokes onToggleCollapse with the row collapse key when the chevron is clicked', () => {
    const onToggleCollapse = vi.fn();
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        chainInstanceId="a-a-1-a"
        collapseKey="a-a-1-a"
        onToggleCollapse={onToggleCollapse}
      />
    );

    screen.getByTestId('chain-collapse-toggle-A').click();
    expect(onToggleCollapse).toHaveBeenCalledWith('a-a-1-a');
  });

  it('keeps duplicate chain labels and partner/entity metadata out of visible row chrome', () => {
    render(
      <SequenceTrack
        chain={{
          ...CHAIN,
          chainId: 'H',
          chainLabel: 'Chain H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'H',
          entityId: '2',
        }}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        detailControl={{
          memberId: 'member:entity-2',
          targetId: 'h-h-2-h',
          checked: true,
          label: 'Chain H',
          roleLabel: 'Partner',
          groupLabel: 'Entity 2',
          badges: ['auth H', 'entity 2'],
          focusIndex: 0,
          testId: 'structure-detail-chain-H',
          onToggle: vi.fn(),
        }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const row = screen.getByTestId('chain-track-H');
    const header = screen.getByTestId('chain-header');
    const primaryLine = screen.getByTestId('chain-primary-line');

    expect(primaryLine).toHaveTextContent('Chain H');
    expect(primaryLine.querySelectorAll('[data-testid="chain-detail-label"]')).toHaveLength(0);
    expect(screen.queryByTestId('chain-meta-line')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent('Partner');
    expect(row).not.toHaveTextContent('entity 2');
    expect(header.getAttribute('data-detail-summary')).toBe('Partner | auth H | entity 2');
  });

  it('uses the Molstar auth-chain color key without a colored badge background', () => {
    render(
      <SequenceTrack
        chain={{
          ...CHAIN,
          chainId: 'H',
          chainLabel: 'Chain H',
          baseChain: 'H',
          labelAsymId: 'H',
          authAsymId: 'B',
        }}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const badge = screen.getByText('Chain B');
    expect(screen.queryByText('Chain H')).not.toBeInTheDocument();
    expect(screen.getByTestId('chain-track-H')).toHaveAttribute('data-chain-color', '#2ca02c');
    expect(screen.getByTestId('chain-color-swatch-H')).toHaveStyle({
      backgroundColor: 'rgb(44, 160, 44)',
    });
    expect(screen.getByTestId('chain-header')).toHaveClass('bg-bg-subtle');
    expect(badge).not.toHaveStyle({ backgroundColor: 'rgba(44, 160, 44, 0.14)' });
  });

  it('renders ordinary amino acids as text in a cohesive sequence, not rounded color tiles', () => {
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        chainColor="#1f77ff"
        interactionState={INTERACTION_STATE}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const residue = screen.getByTestId('residue-A-2');
    expect(residue).toHaveClass('rounded-none');
    expect(residue).toHaveClass('pointer-events-auto');
    expect(residue).not.toHaveClass('shrink-0');
    expect(residue).not.toHaveClass('z-10');
    expect(residue).not.toHaveClass('rounded-sm');
    expect(residue.style.backgroundColor).toBe('transparent');
    expect(residue.style.color).toBe('rgb(31, 119, 255)');
  });

  it('uses the same rounded box geometry for hover while keeping Molstar pink', () => {
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={{
          hovered: { chain: 'A', position: 3 },
          selected: [],
        }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const hovered = screen.getByTestId('residue-A-3');
    const hoverFrame = screen.getByTestId('residue-A-3-hover-frame');
    expect(hovered.style.width).toBe('7px');
    expect(hovered).toHaveClass('group');
    expect(hovered).not.toHaveClass('hover:opacity-80');
    expect(hovered.style.backgroundColor).toBe('transparent');
    expect(hovered.style.borderTop).toBe('');
    expect(hovered.style.borderLeft).toBe('');
    expect(hovered.style.marginLeft).toBe('');
    expect(hovered.style.paddingLeft).toBe('');
    expect(hoverFrame).toHaveClass('opacity-0');
    expect(hoverFrame).toHaveClass('group-hover:opacity-100');
    expect(hoverFrame.style.position).toBe('absolute');
    expect(hoverFrame.style.left).toBe('0px');
    expect(hoverFrame.style.right).toBe('0px');
    expect(hoverFrame.style.top).toBe('0px');
    expect(hoverFrame.style.bottom).toBe('0px');
    expect(hoverFrame.style.opacity).toBe('1');
    expect(hoverFrame.style.borderTop).toBe('1px solid rgb(255, 102, 153)');
    expect(hoverFrame.style.borderBottom).toBe('1px solid rgb(255, 102, 153)');
    expect(hoverFrame.style.borderLeft).toBe('1px solid rgb(255, 102, 153)');
    expect(hoverFrame.style.borderRight).toBe('1px solid rgb(255, 102, 153)');
    expect(hoverFrame.style.borderTopLeftRadius).toBe('2px');
    expect(hoverFrame.style.borderTopRightRadius).toBe('2px');
    expect(hovered).not.toHaveClass('ring-1');
    expect(hovered).not.toHaveClass('ring-pink-500');
  });

  it('keeps selected residues as one grouped run using the Molstar lime selection color', () => {
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={{
          hovered: null,
          selected: [
            { chain: 'A', position: 2 },
            { chain: 'A', position: 3 },
          ],
        }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const firstSelected = screen.getByTestId('residue-A-2');
    const secondSelected = screen.getByTestId('residue-A-3');
    const firstFrame = screen.getByTestId('residue-A-2-interaction-frame');
    const secondFrame = screen.getByTestId('residue-A-3-interaction-frame');

    expect(firstSelected.style.borderTop).toBe('');
    expect(firstSelected.style.borderLeft).toBe('');
    expect(firstSelected.style.marginLeft).toBe('');
    expect(firstSelected.style.paddingLeft).toBe('');
    expect(firstFrame.style.backgroundColor).toBe(HIGHLIGHT_COLORS.selected.bg);
    expect(firstFrame.style.borderTop).toBe('1px solid rgb(51, 255, 25)');
    expect(firstFrame.style.borderTopLeftRadius).toBe('2px');
    expect(firstFrame.style.borderTopRightRadius).toBe('0');
    expect(firstFrame.style.right).toBe('-1px');
    expect(firstFrame.style.borderRight).toBe('');

    expect(secondSelected.style.borderTop).toBe('');
    expect(secondSelected.style.borderLeft).toBe('');
    expect(secondSelected.style.marginLeft).toBe('');
    expect(secondSelected.style.paddingLeft).toBe('');
    expect(secondFrame.style.backgroundColor).toBe(HIGHLIGHT_COLORS.selected.bg);
    expect(secondFrame.style.borderTop).toBe('1px solid rgb(51, 255, 25)');
    expect(secondFrame.style.borderTopLeftRadius).toBe('0');
    expect(secondFrame.style.borderTopRightRadius).toBe('2px');
    expect(secondFrame.style.left).toBe('-1px');
    expect(secondFrame.style.borderLeft).toBe('');
  });

  it('renders adjacent saved selections with the exact active-green selection frame styling', () => {
    const { rerender } = render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={{
          hovered: null,
          selected: [
            { chain: 'A', position: 2 },
            { chain: 'A', position: 3 },
          ],
        }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const activeFrameStyles = [
      screen.getByTestId('residue-A-2-interaction-frame').style.cssText,
      screen.getByTestId('residue-A-3-interaction-frame').style.cssText,
    ];

    rerender(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={INTERACTION_STATE}
        highlightGroups={[
          {
            id: 'saved-selection-one',
            label: 'First saved selection',
            color: '#22c55e',
            visible: true,
            selections: [{ chain: 'A', ranges: [[2, 2]] }],
          },
          {
            id: 'saved-selection-two',
            label: 'Second saved selection',
            color: '#22c55e',
            visible: true,
            selections: [
              {
                chain: 'A',
                ranges: [
                  [3, 3],
                  [5, 5],
                ],
              },
            ],
          },
        ]}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const savedFrameStyles = [
      screen.getByTestId('residue-A-2-interaction-frame').style.cssText,
      screen.getByTestId('residue-A-3-interaction-frame').style.cssText,
    ];
    const disjointFrame = screen.getByTestId('residue-A-5-interaction-frame');

    expect(savedFrameStyles).toEqual(activeFrameStyles);
    expect(disjointFrame.style.backgroundColor).toBe(HIGHLIGHT_COLORS.selected.bg);
    expect(disjointFrame.style.borderLeft).toBe('1px solid rgb(51, 255, 25)');
    expect(disjointFrame.style.borderRight).toBe('1px solid rgb(51, 255, 25)');
  });

  it('does not draw touching end strokes between adjacent active and saved residues', () => {
    render(
      <SequenceTrack
        chain={CHAIN}
        colorMode="chain"
        interactionState={{
          hovered: null,
          selected: [{ chain: 'A', position: 2 }],
        }}
        highlightGroups={[
          {
            id: 'saved-selection-adjacent',
            label: 'Adjacent saved residue',
            color: '#22c55e',
            visible: true,
            renderMode: 'annotation',
            selections: [{ chain: 'A', ranges: [[3, 3]] }],
          },
        ]}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const activeFrame = screen.getByTestId('residue-A-2-interaction-frame');
    const savedFrame = screen.getByTestId('residue-A-3-interaction-frame');

    expect(activeFrame.style.borderRight).toBe('');
    expect(activeFrame.style.borderTopRightRadius).toBe('0');
    expect(savedFrame.style.borderLeft).toBe('');
    expect(savedFrame.style.borderTopLeftRadius).toBe('0');
    expect(savedFrame.style.backgroundColor).toBe(HIGHLIGHT_COLORS.selected.bg);
    expect(savedFrame.style.borderTop).toBe('1px solid rgb(51, 255, 25)');
  });

  it('does not paint the top amino-acid row from a same chain-position selection with a different structure scope', () => {
    const scopedChain: ChainSequence = {
      ...CHAIN,
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
    };
    const props = {
      chain: scopedChain,
      colorMode: 'chain' as const,
      onHover: vi.fn(),
      onSelect: vi.fn(),
    };

    const { rerender } = render(
      <SequenceTrack
        {...props}
        interactionState={{
          hovered: null,
          selected: [
            {
              chain: 'A',
              position: 3,
              baseChain: 'A',
              labelAsymId: 'A',
              authAsymId: 'G',
              entityId: '1',
            },
          ],
        }}
      />
    );

    const scopedResidue = screen.getByTestId('residue-A-3');
    expect(scopedResidue).toHaveAttribute('data-auth-asym-id', 'H');
    expect(scopedResidue).not.toHaveAttribute('data-state', 'selected');
    expect(screen.queryByTestId('residue-A-3-interaction-frame')).not.toBeInTheDocument();

    rerender(
      <SequenceTrack
        {...props}
        interactionState={{
          hovered: null,
          selected: [
            {
              chain: 'A',
              position: 3,
              baseChain: 'A',
              labelAsymId: 'A',
              authAsymId: 'H',
              entityId: '1',
            },
          ],
        }}
      />
    );

    expect(screen.getByTestId('residue-A-3')).toHaveAttribute('data-state', 'selected');
    expect(screen.getByTestId('residue-A-3-interaction-frame')).toBeInTheDocument();
  });

  it('memoizes unrelated chain rows when hover moves on another chain', () => {
    const props: SequenceTrackProps = {
      chain: CHAIN,
      colorMode: 'chain',
      interactionState: {
        hovered: null,
        selected: [],
      },
      onHover: vi.fn(),
      onSelect: vi.fn(),
    };

    expect(
      areSequenceTrackPropsEqual(props, {
        ...props,
        interactionState: {
          hovered: { chain: 'B', position: 42 },
          selected: [],
        },
      })
    ).toBe(true);
    expect(
      areSequenceTrackPropsEqual(props, {
        ...props,
        interactionState: {
          hovered: { chain: 'A', position: 3 },
          selected: [],
        },
      })
    ).toBe(false);
  });
});
