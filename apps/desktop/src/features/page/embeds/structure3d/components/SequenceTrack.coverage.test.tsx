/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChainSequence, ResidueInteractionState } from '../types';
import { useStructure3dStore } from '../store';
import { createPolymerResidueDisplayProjection } from '../utils/polymerResidueDisplay';
import { residueLocationsForChain, SequenceTrack } from './SequenceTrack';

const CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  baseChain: 'A',
  labelAsymId: 'A',
  authAsymId: 'G',
  entityId: '2',
  operator: 'ASM_1',
  sequence: 'MSTK',
  residues: [
    { position: 19, sequenceIndex: 1, labelSeqId: 1, name: 'M', name3: 'MET' },
    { position: 20, sequenceIndex: 2, labelSeqId: 2, name: 'S', name3: 'SER' },
    { position: 21, sequenceIndex: 3, labelSeqId: 3, name: 'T', name3: 'THR' },
    { position: 23, sequenceIndex: 5, labelSeqId: 4, name: 'K', name3: 'LYS' },
  ],
};

const SOURCE_SEQUENCE = 'AMSTQKY';

function interactionState(selectedPositions: readonly number[] = []): ResidueInteractionState {
  return {
    hovered: null,
    selected: CHAIN.residues
      .filter((residue) => selectedPositions.includes(residue.position))
      .map((residue) => ({
        chain: 'A',
        position: residue.position,
        labelSeqId: residue.labelSeqId,
        labelCompId: residue.name3,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'G',
        entityId: '2',
        operator: 'ASM_1',
      })),
  };
}

function StoredSequenceTrack({ chain, viewId }: { chain: ChainSequence; viewId: string }) {
  const selection = useStructure3dStore((state) => state.interactionState[viewId]);
  return (
    <SequenceTrack
      chain={chain}
      polymerResidueDisplay={createPolymerResidueDisplayProjection(chain, SOURCE_SEQUENCE)}
      colorMode="chain"
      interactionState={selection ?? interactionState()}
      onHover={() => {}}
      onSelect={(residue, gesture, orderedResidues) =>
        useStructure3dStore.getState().selectResidue(viewId, residue, gesture, orderedResidues)
      }
    />
  );
}

describe('SequenceTrack polymer coordinate coverage', () => {
  it.each([true, false])(
    'extends mapped Shift selection through the real store with physical instance identity (primary=%s)',
    (isPrimarySource) => {
      const viewId = `mapped-physical-${isPrimarySource}`;
      const chain: ChainSequence = {
        ...CHAIN,
        structureRef: 'primary-structure',
        instanceId: 'primary-structure:A:ASM_1',
        isPrimarySource,
      };
      useStructure3dStore.getState().resetInteractionState(viewId);
      render(<StoredSequenceTrack chain={chain} viewId={viewId} />);

      fireEvent.click(screen.getByTestId('residue-A-19'));
      fireEvent.click(screen.getByTestId('residue-A-23'), { shiftKey: true });

      const state = useStructure3dStore.getState();
      expect(state.interactionState[viewId]?.selected.map((residue) => residue.position)).toEqual([
        19, 20, 21, 23,
      ]);
      expect(state.selectionAnchor[viewId]).toMatchObject({
        position: 19,
        structureRef: chain.structureRef,
        instanceId: chain.instanceId,
      });
      expect(state.interactionState[viewId]?.selected).toEqual(
        expect.arrayContaining(
          [19, 20, 21, 23].map((position) =>
            expect.objectContaining({
              position,
              structureRef: chain.structureRef,
              instanceId: chain.instanceId,
              isPrimarySource,
            })
          )
        )
      );
      expect(
        screen
          .getByTestId('chain-sequence')
          .querySelectorAll('[data-state="selected"][data-position]')
      ).toHaveLength(4);
    }
  );

  it('keeps a mapped Shift range inside its physical instance', () => {
    const viewId = 'mapped-other-instance';
    const chain: ChainSequence = {
      ...CHAIN,
      structureRef: 'primary-structure',
      instanceId: 'primary-structure:A:ASM_1',
      isPrimarySource: true,
    };
    const otherAnchor = {
      ...residueLocationsForChain(chain)[0],
      structureRef: 'second-structure',
      instanceId: 'second-structure:A:ASM_1',
    };
    useStructure3dStore.getState().setSelected(viewId, [otherAnchor], otherAnchor);
    render(<StoredSequenceTrack chain={chain} viewId={viewId} />);

    fireEvent.click(screen.getByTestId('residue-A-23'), { shiftKey: true });

    expect(useStructure3dStore.getState().interactionState[viewId]?.selected).toEqual([
      expect.objectContaining({
        position: 23,
        structureRef: chain.structureRef,
        instanceId: chain.instanceId,
      }),
    ]);
    expect(useStructure3dStore.getState().selectionAnchor[viewId]?.position).toBe(23);
  });

  it('renders the linked polymer, marks definitive gaps, and never turns a gap into a Mol* target', () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    const onContextMenu = vi.fn();
    const projection = createPolymerResidueDisplayProjection(CHAIN, SOURCE_SEQUENCE);
    expect(projection.status).toBe('mapped');

    render(
      <div onContextMenu={onContextMenu}>
        <SequenceTrack
          chain={CHAIN}
          polymerResidueDisplay={projection}
          colorMode="chain"
          interactionState={interactionState()}
          onHover={onHover}
          onSelect={onSelect}
        />
      </div>
    );

    const sequence = screen.getByTestId('chain-sequence');
    expect(sequence.children).toHaveLength(SOURCE_SEQUENCE.length);
    expect(screen.getByText('4 / 7 modeled')).toBeInTheDocument();

    const missingNTerminus = screen.getByTestId('missing-residue-A-1');
    expect(missingNTerminus).toHaveAttribute('data-coordinate-status', 'missing');
    expect(missingNTerminus).toHaveAttribute('data-polymer-index', '0');
    expect(missingNTerminus).toHaveAttribute(
      'aria-label',
      'Residue 1 A is not modeled in this structure'
    );
    expect(missingNTerminus).toHaveClass('text-fg-subtle', 'border-dotted');
    expect(missingNTerminus).not.toHaveAttribute('data-position');
    expect(missingNTerminus).not.toHaveAttribute('data-label-seq-id');
    expect(missingNTerminus).not.toHaveAttribute('data-auth-asym-id');
    expect(missingNTerminus).not.toHaveAttribute('tabindex');

    fireEvent.mouseEnter(missingNTerminus);
    fireEvent.click(missingNTerminus);
    fireEvent.contextMenu(missingNTerminus);
    expect(onHover).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledTimes(1);

    const modeled = screen.getByTestId('residue-A-19');
    expect(modeled).toHaveAttribute('data-coordinate-status', 'modeled');
    expect(modeled).toHaveAttribute('data-polymer-index', '1');
    expect(modeled).toHaveAttribute('data-source-residue-name', 'M');
    expect(modeled).toHaveAttribute('data-coordinate-residue-name', 'M');
    expect(modeled).toHaveAttribute('data-identity-relation', 'exact');
    expect(within(modeled).getByText('M')).toBeInTheDocument();
  });

  it('Shift-selects in polymer display order while filtering every missing coordinate', () => {
    const onSelect = vi.fn();
    const projection = createPolymerResidueDisplayProjection(CHAIN, SOURCE_SEQUENCE);

    render(
      <SequenceTrack
        chain={CHAIN}
        polymerResidueDisplay={projection}
        colorMode="chain"
        interactionState={interactionState()}
        onHover={vi.fn()}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByTestId('residue-A-19'));
    fireEvent.click(screen.getByTestId('residue-A-23'), { shiftKey: true });

    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: 'A', position: 23, labelSeqId: 4 }),
      'range',
      [
        expect.objectContaining({ position: 19, labelSeqId: 1 }),
        expect.objectContaining({ position: 20, labelSeqId: 2 }),
        expect.objectContaining({ position: 21, labelSeqId: 3 }),
        expect.objectContaining({ position: 23, labelSeqId: 4 }),
      ]
    );
  });

  it('breaks grouped selection strokes across a missing-coordinate cell', () => {
    const projection = createPolymerResidueDisplayProjection(CHAIN, SOURCE_SEQUENCE);
    render(
      <SequenceTrack
        chain={CHAIN}
        polymerResidueDisplay={projection}
        colorMode="chain"
        interactionState={interactionState([21, 23])}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('residue-A-21-interaction-frame').style.borderRight).not.toBe('none');
    expect(screen.getByTestId('residue-A-23-interaction-frame').style.borderLeft).not.toBe('none');
  });

  it('keeps the honest coordinate sequence when mapping certainty is unavailable', () => {
    const projection = createPolymerResidueDisplayProjection(CHAIN, 'MAAAK');
    expect(projection.status).toBe('unavailable');

    render(
      <SequenceTrack
        chain={CHAIN}
        polymerResidueDisplay={projection}
        colorMode="chain"
        interactionState={interactionState()}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('chain-track-A')).toHaveAttribute(
      'data-polymer-coverage-status',
      'unavailable'
    );
    expect(screen.getByText('Polymer mapping unavailable')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^missing-residue-/)).toHaveLength(0);
    expect(screen.getByTestId('chain-sequence').children).toHaveLength(CHAIN.residues.length);
  });
});
