import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChainSequence, StructureColoration } from '../types';
import { SequenceTrack } from './SequenceTrack';
import { ResidueBox } from './ResidueBox';
import { ColorLegend } from './ColorLegend';
import { Color } from 'molstar/lib/mol-util/color';

function chainWithColoration(coloration: StructureColoration): ChainSequence {
  return {
    chainId: 'E',
    chainLabel: 'Chain E',
    sequence: 'A',
    coloration,
    residues: [{ position: 1, name: 'A', name3: 'ALA', coloration }],
  };
}

describe('sequence display of native molecular colors', () => {
  it('tints atomic detail with the exact native alpha-carbon color instead of gray', () => {
    const chain = chainWithColoration({ kind: 'uniform', color: 0xffa500 });
    Object.assign(chain.residues[0], {
      atomicDetail: 'backbone',
      alphaCarbonColoration: { kind: 'uniform', color: 0x33aabb },
    });
    render(
      <SequenceTrack
        chain={chain}
        colorMode="chain"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('residue-E-1').style.backgroundColor).toBe(
      'rgba(51, 170, 187, 0.13)'
    );
    expect(screen.getByTestId('residue-color-tile').style.backgroundColor).toBe('rgb(255, 165, 0)');
    expect(screen.getByTestId('residue-color-tile').style.boxShadow).toContain('inset');
  });

  it.each([
    undefined,
    { kind: 'unrepresented' },
    { kind: 'unavailable' },
    { kind: 'multiple', colors: [0x33aabb, 0xffa500] },
  ])(
    'leaves the atomic-detail background uncolored when CA color is %s',
    (alphaCarbonColoration) => {
      const chain = chainWithColoration({ kind: 'uniform', color: 0xffa500 });
      Object.assign(chain.residues[0], { atomicDetail: 'atoms', alphaCarbonColoration });
      render(
        <SequenceTrack
          chain={chain}
          colorMode="chain"
          chainColor="#e6194b"
          interactionState={{ hovered: null, selected: [] }}
          onHover={vi.fn()}
          onSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId('residue-E-1').style.backgroundColor).toBe('transparent');
      if (!alphaCarbonColoration)
        expect(screen.getByTestId('residue-E-1').title).toContain('has not been resolved');
      else if (alphaCarbonColoration.kind === 'unrepresented')
        expect(screen.getByTestId('residue-E-1').title).toContain('No alpha carbon is drawn');
    }
  );

  it('uses a custom native color for both title and letters over a legacy palette', () => {
    render(
      <SequenceTrack
        chain={chainWithColoration({ kind: 'uniform', color: 0xffa500 })}
        colorMode="chain"
        chainColor="#e6194b"
        displayColor="#e6194b"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('Chain E').style.color).toBe('rgb(255, 165, 0)');
    expect(screen.getByTestId('residue-color-tile').style.backgroundColor).toBe('rgb(255, 165, 0)');
    expect(screen.getByTestId('chain-color-swatch-E').style.backgroundColor).toBe(
      'rgb(255, 165, 0)'
    );
  });

  it('never draws a colored bar beneath a compound-colored residue', () => {
    render(
      <SequenceTrack
        chain={chainWithColoration({ kind: 'multiple', colors: [0x0000ff, 0xffa500] })}
        colorMode="element"
        chainColor="#e6194b"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('Chain E').style.color).toBe('hsl(var(--color-fg))');
    expect(screen.getByTestId('chain-track-E').dataset.colorationKind).toBe('multiple');
    const letter = screen.getByTestId('residue-label');
    expect(letter.textContent).toBe('A');
    expect(letter.style.color).toBe('hsl(var(--color-fg))');
    expect(letter.style.backgroundImage).toBe('');
    expect(screen.queryByTestId('residue-multiple-color-marker')).toBeNull();
    expect(screen.getByTestId('residue-E-1').dataset.molecularColors).toBe('#0000ff,#ffa500');
    expect(
      screen.getByTestId('residue-E-1').querySelectorAll('[data-testid="residue-label"]')
    ).toHaveLength(1);
  });

  it('uses a neutral title for a partly represented chain', () => {
    render(
      <SequenceTrack
        chain={{
          ...chainWithColoration({ kind: 'partial', colors: [0xffd400] }),
          sequence: 'AG',
          residues: [
            {
              position: 1,
              name: 'A',
              name3: 'ALA',
              coloration: { kind: 'uniform', color: 0xffd400 },
            },
            { position: 2, name: 'G', name3: 'GLY', coloration: { kind: 'unrepresented' } },
          ],
        }}
        colorMode="chain"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('Chain E').style.color).toBe('hsl(var(--color-fg))');
    expect(screen.getByTestId('chain-track-E').dataset.colorationKind).toBe('partial');
    expect(screen.getByTestId('chain-color-swatch-E').style.backgroundColor).toBe('transparent');
    expect(screen.getAllByTestId('residue-color-tile')).toHaveLength(1);
    expect(screen.getByTestId('residue-color-tile').style.backgroundColor).toBe('rgb(255, 212, 0)');
    expect(screen.getByTestId('chain-visibility-E').textContent).toBe('1/2 drawn in 3D');
    expect(screen.getByTestId('residue-E-2').dataset.colorationKind).toBe('unrepresented');
    expect(screen.getAllByTestId('residue-label')[1].style.textDecorationLine).toBe('line-through');
    expect(screen.getAllByTestId('residue-label')[0].style.textDecorationLine).toBe('');
  });

  it('preserves native atomic detail and letter color without showing atom-range badges', () => {
    const onSelectChain = vi.fn();
    const chain: ChainSequence = {
      chainId: 'C',
      chainLabel: 'Chain C',
      sequence: 'AAAAAAA',
      residues: Array.from({ length: 7 }, (_, index) => ({
        position: index + 74,
        name: 'A',
        name3: 'ALA',
        coloration: { kind: 'uniform' as const, color: 0xaabfc6 },
        ...(index >= 1 && index <= 5 ? { atomicDetail: 'backbone' as const } : {}),
      })),
    };
    render(
      <SequenceTrack
        chain={chain}
        chainInstanceId="c-assembly-1"
        colorMode="chain"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        onSelectChain={onSelectChain}
      />
    );

    expect(screen.queryByTestId('chain-atomic-detail-C')).toBeNull();
    expect(screen.getByTestId('residue-C-75').dataset.atomicDetail).toBe('backbone');
    expect(screen.getByTestId('residue-C-74').dataset.atomicDetail).toBeUndefined();
    expect(
      screen
        .getByTestId('residue-C-75')
        .querySelector('[data-testid="residue-color-tile"]')
        ?.getAttribute('style')
    ).toContain('rgb(170, 191, 198)');
    expect(onSelectChain).not.toHaveBeenCalled();
  });

  it('uses the neutral title color for a partially drawn chain checkbox', () => {
    const onToggleVisibility = vi.fn();
    render(
      <SequenceTrack
        chain={{
          ...chainWithColoration({ kind: 'partial', colors: [0xffd400] }),
          sequence: 'AG',
          residues: [
            {
              position: 1,
              name: 'A',
              name3: 'ALA',
              coloration: { kind: 'uniform', color: 0xffd400 },
            },
            { position: 2, name: 'G', name3: 'GLY', coloration: { kind: 'unrepresented' } },
          ],
        }}
        chainInstanceId="chain-e"
        chainColor="#1f77b4"
        colorMode="chain"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
        onToggleVisibility={onToggleVisibility}
      />
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Hide chain E' });
    expect(checkbox.getAttribute('aria-checked')).toBe('mixed');
    expect(checkbox.getAttribute('data-visibility-state')).toBe('partial');
    expect(checkbox.style.backgroundColor).toBe('hsl(var(--color-fg))');
    expect(checkbox.style.borderColor).toBe(screen.getByText('Chain E').style.color);
    expect(checkbox.querySelector('[data-testid="chain-visibility-dash-E"]')).not.toBeNull();
    checkbox.click();
    expect(onToggleVisibility).toHaveBeenCalledWith('chain-e', false);
  });

  it.each([
    [{ kind: 'uniform', color: 0xffa500 }, 'rgb(255, 165, 0)', '#ffa500'],
    [
      { kind: 'multiple', colors: [0x0000ff, 0xffa500] },
      'hsl(var(--color-fg))',
      'hsl(var(--color-fg))',
    ],
  ] as const)(
    'uses native %s appearance for both chain controls',
    (coloration, expectedColor, expectedAccent) => {
      render(
        <SequenceTrack
          chain={chainWithColoration(coloration)}
          chainInstanceId="chain-e"
          chainColor="#1f77b4"
          colorMode="chain"
          detailControl={{
            memberId: 'member-e',
            targetId: 'chain-e',
            checked: true,
            label: 'Chain E',
            roleLabel: 'Partner',
            badges: [],
            focusIndex: 0,
            testId: 'detail-chain-e',
            onToggle: vi.fn(),
          }}
          interactionState={{ hovered: null, selected: [] }}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          onToggleVisibility={vi.fn()}
        />
      );
      const checkbox = screen.getByRole('checkbox', { name: 'Hide chain E' });
      expect(screen.getByText('Chain E').style.color).toBe(expectedColor);
      expect(checkbox.style.borderColor).toBe(expectedColor);
      expect(checkbox.style.backgroundColor).toBe(expectedColor);
      expect(screen.getByTestId('detail-chain-e').style.accentColor).toBe(expectedAccent);
    }
  );

  it('restores a masked chain but does not promise to show a chain omitted by the scene', () => {
    const onToggleVisibility = vi.fn();
    const props = {
      chain: chainWithColoration({ kind: 'unrepresented' } as const),
      chainInstanceId: 'chain-e',
      colorMode: 'chain' as const,
      interactionState: { hovered: null, selected: [] },
      onHover: vi.fn(),
      onSelect: vi.fn(),
      onToggleVisibility,
    };
    const { rerender } = render(<SequenceTrack {...props} />);
    const omitted = screen.getByRole('checkbox', {
      name: 'Chain E is not drawn in this view',
    });
    expect(omitted.hasAttribute('disabled')).toBe(true);
    omitted.click();
    expect(onToggleVisibility).not.toHaveBeenCalled();

    rerender(<SequenceTrack {...props} visibilityMasked />);
    const restore = screen.getByRole('checkbox', { name: 'Restore chain E' });
    expect(restore.hasAttribute('disabled')).toBe(false);
    restore.click();
    expect(onToggleVisibility).toHaveBeenCalledWith('chain-e', true);
  });

  it('identifies a wholly omitted chain without mistaking it for an unmodeled polymer', () => {
    render(
      <SequenceTrack
        chain={chainWithColoration({ kind: 'unrepresented' })}
        colorMode="chain"
        interactionState={{ hovered: null, selected: [] }}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('chain-visibility-E').textContent).toBe('Not drawn in 3D');
    expect(screen.getByTestId('chain-color-swatch-E').style.backgroundColor).toBe('transparent');
    expect(screen.getByTestId('residue-label').style.textDecorationLine).toBe('line-through');
  });

  it('keeps the native tile color during hover and selection', () => {
    render(
      <ResidueBox
        residue={{
          position: 1,
          name: 'A',
          name3: 'ALA',
          coloration: { kind: 'uniform', color: 0x800080 },
        }}
        chainId="G"
        colorMode="bfactor"
        isHovered
        isSelected
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('residue-color-tile').style.backgroundColor).toBe('rgb(128, 0, 128)');
    expect(screen.getByTestId('residue-G-1-interaction-frame')).toBeTruthy();
  });

  it('draws the native theme legend without imposing its own color scale', () => {
    render(
      <ColorLegend
        legends={[
          {
            kind: 'table-legend',
            table: [['Custom chain', Color(0xffa500)]],
          },
        ]}
      />
    );
    expect(
      screen.getByText('Custom chain').previousElementSibling?.getAttribute('style')
    ).toContain('rgb(255, 165, 0)');
  });

  it('identifies unavailable residue coloring instead of showing the old palette', () => {
    render(
      <ResidueBox
        residue={{ position: 1, name: 'A', name3: 'ALA', coloration: { kind: 'unavailable' } }}
        chainId="E"
        colorMode="chain"
        chainColor="#e6194b"
        isHovered={false}
        isSelected={false}
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('residue-E-1').title).toBe(
      'This coloring cannot be mapped to an individual residue.'
    );
    expect(screen.getByTestId('residue-label').style.color).toBe('hsl(var(--color-fg-muted))');
  });
});
