import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Color } from 'molstar/lib/mol-util/color';
import { ColorLegend } from './ColorLegend';
import type { MolViewSpecColorGroup } from '../molstar/molViewSpecLegend';

describe('named molecular swatches', () => {
  it('keeps identically named and colored rows bound to their own physical groups', () => {
    const select = vi.fn();
    const focus = vi.fn();
    const groups = ['site-copy', 'context-copy'].map((id) => ({
      id,
      label: 'Bound ligand',
      color: Color(0xb74583),
      selectable: true,
      structureCount: 1,
      targets: [
        {
          structureIndex: 0,
          componentSelector: { auth_seq_id: id === 'site-copy' ? 601 : 602 },
          colorSelector: 'all',
          laterColorSelectors: [],
        },
      ],
    }));
    render(
      <ColorLegend
        legends={[{ kind: 'table-legend', table: groups.map((g) => [g.label, g.color]) }]}
        namedGroups={groups}
        onSelectNamedGroup={select}
        onFocusNamedGroup={focus}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Select Bound ligand' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Target Bound ligand' })[1]);
    expect(select).toHaveBeenCalledWith(groups[1]);
    expect(focus).toHaveBeenCalledWith(groups[1]);
  });
  it('selects a scene-authored group without turning native legends into selection controls', () => {
    const select = vi.fn();
    const focus = vi.fn();
    const group = {
      id: 'Pocket\u0000b74583',
      label: 'Pocket',
      color: Color(0xb74583),
      selectable: true,
      structureCount: 1,
      targets: [
        {
          structureIndex: 0,
          componentSelector: 'protein',
          colorSelector: 'all',
          laterColorSelectors: [],
        },
      ],
    };
    render(
      <ColorLegend
        legends={[
          { kind: 'table-legend', table: [['Pocket', Color(0xb74583)]] },
          { kind: 'table-legend', table: [['Native theme', Color(0x123456)]] },
        ]}
        namedGroups={[group]}
        onSelectNamedGroup={select}
        onFocusNamedGroup={focus}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select Pocket' }));
    expect(select).toHaveBeenCalledWith(group);
    expect(focus).not.toHaveBeenCalled();
    select.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Target Pocket' }));
    expect(focus).toHaveBeenCalledWith(group);
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Native theme' })).toBeNull();
  });
  it('draws a selection painted in several colors with a multicolor swatch ', () => {
    const group = (multicolor: boolean) => ({
      id: `Polymer context${multicolor}`,
      label: multicolor ? 'Polymer context' : 'Pocket',
      color: Color(0x3388ff),
      selectable: true,
      structureCount: 1,
      targets: [],
      ...(multicolor ? { multicolor: true as const } : {}),
    });
    const groups = [group(true), group(false)];
    render(
      <ColorLegend
        legends={[{ kind: 'table-legend', table: groups.map((g) => [g.label, g.color]) }]}
        namedGroups={groups}
        onSelectNamedGroup={vi.fn()}
      />
    );
    const swatch = (name: string) =>
      screen.getByRole('button', { name: `Select ${name}` }).querySelector('span')!;
    expect(swatch('Polymer context').style.background).toContain('conic-gradient');
    expect(swatch('Polymer context').style.backgroundColor).toBe('');
    expect(swatch('Pocket').style.background).not.toContain('conic-gradient');
    expect(swatch('Pocket').style.backgroundColor).not.toBe('');
  });
  it('splits a multicolor swatch into one equal sector per drawn color up to the cap ', () => {
    const palette = [0x1b9e77, 0xd95f02, 0x7570b3, 0xe7298a, 0x66a61e, 0xe6ab02, 0xa6761d];
    const group = (label: string, swatch: NonNullable<MolViewSpecColorGroup['swatch']>) => ({
      id: label,
      label,
      color: Color(0x3388ff),
      selectable: true,
      structureCount: 1,
      targets: [],
      multicolor: true as const,
      swatch,
    });
    const groups = [
      group('Two chains', { kind: 'colors', colors: palette.slice(0, 2).map((c) => Color(c)) }),
      group('Seven chains', { kind: 'colors', colors: palette.map((c) => Color(c)) }),
      group('B-factor', { kind: 'gradient', colors: [Color(0x0000ff), Color(0xff0000)] }),
    ];
    render(
      <ColorLegend
        legends={[{ kind: 'table-legend', table: groups.map((g) => [g.label, g.color]) }]}
        namedGroups={groups}
        onSelectNamedGroup={vi.fn()}
      />
    );
    const swatch = (name: string) =>
      screen.getByRole('button', { name: `Select ${name}` }).querySelector('span')!.style
        .background;
    expect(swatch('Two chains')).toBe('conic-gradient(#1b9e77 0deg 180deg, #d95f02 180deg 360deg)');
    expect(swatch('Seven chains')).toContain('conic-gradient(#e6194b');
    expect(swatch('B-factor')).toBe('linear-gradient(to right, #0000ff, #ff0000)');
  });
  it('shows each color key under its title ', () => {
    render(
      <ColorLegend
        legends={[]}
        colorKeys={[
          {
            title: 'B-factor (Å²)',
            legend: {
              kind: 'scale-legend',
              minLabel: '0',
              maxLabel: '100',
              colors: [Color(0x0000ff), Color(0xff0000)],
            },
          },
        ]}
      />
    );
    const key = screen.getByTestId('structure-color-key');
    expect(key).toHaveTextContent('B-factor (Å²)');
    expect(key).toHaveTextContent('0');
    expect(key).toHaveTextContent('100');
  });
});
