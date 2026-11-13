// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { ActiveEnzymeList } from './ActiveEnzymeList';

function enzyme(name: string): RestrictionEnzyme {
  return {
    name,
    recognition_sequence: 'GAATTC',
    recognition_sequence_length: 6,
    cut_position_top: 1,
    cut_position_bottom: 5,
    overhang_type: null,
    overhang_length: null,
    enzyme_type: 'Type II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  } as unknown as RestrictionEnzyme;
}

describe('ActiveEnzymeList cut-positions label ', () => {
  afterEach(cleanup);

  it('labels the positions row "cuts at" and not "cuts:" / "Cut sites:"', () => {
    render(
      <ActiveEnzymeList
        enzymes={[
          {
            enzyme: enzyme('EcoRI'),
            cutCount: 1,
            cutPositions: [{ position: 600, recognitionStart: 599, recognitionEnd: 605 }],
            color: '#3b82f6',
          },
        ]}
        onRemove={() => {}}
        onClear={() => {}}
      />
    );

    expect(screen.getByText('cuts at')).toBeTruthy();
    expect(screen.queryByText('cuts:')).toBeNull();
    expect(screen.queryByText('Cut sites:')).toBeNull();

    expect(screen.getByText('1 cut')).toBeTruthy();
    expect(screen.getByText('600')).toBeTruthy();
  });
});

describe('the real static digest activation control', () => {
  afterEach(cleanup);
  it('does not treat focus or wheel as activation and forwards the ordered set on click', () => {
    const onVirtualDigest = vi.fn();
    render(
      <ActiveEnzymeList
        enzymes={[
          { enzyme: enzyme('EcoRI'), cutCount: 1, cutPositions: [], color: '#123456' },
          { enzyme: enzyme('SecondI'), cutCount: 2, cutPositions: [], color: '#654321' },
        ]}
        onRemove={() => {}}
        onClear={() => {}}
        onVirtualDigest={onVirtualDigest}
      />
    );
    const control = screen.getByTestId('virtual-digest-toggle');
    fireEvent.focus(control);
    fireEvent.wheel(control, { deltaY: 100 });
    expect(onVirtualDigest).not.toHaveBeenCalled();
    fireEvent.click(control);
    expect(onVirtualDigest).toHaveBeenCalledTimes(1);
    expect(onVirtualDigest).toHaveBeenCalledWith(['EcoRI', 'SecondI']);
  });
});
