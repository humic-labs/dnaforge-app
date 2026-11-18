// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Bond, StructureElement } from 'molstar/lib/mol-model/structure';
import { Loci as MolstarLoci, type Loci } from 'molstar/lib/mol-model/loci';
import {
  classifyMolstarCanvasPoint,
  extractResidueFromLoci,
  residueAtMolstarCanvasPoint,
  useMolstarInteraction,
} from './useMolstarInteraction';

type Subscription<T> = {
  subscribe: (callback: (event: T) => void) => { unsubscribe: () => void };
  emit: (event: T) => void;
};

type HoverEvent = { current: { loci: Loci }; buttons?: number };
type ClickEvent = HoverEvent & {
  button?: number;
  buttons?: number;
  modifiers?: { shift?: boolean; meta?: boolean; control?: boolean };
};

function createSubscription<T>(): Subscription<T> {
  let callback: ((event: T) => void) | null = null;
  return {
    subscribe(next) {
      callback = next;
      return { unsubscribe: vi.fn() };
    },
    emit(event) {
      if (!callback) {
        throw new Error('subscription has no listener');
      }
      callback(event);
    },
  };
}

function table<T>(values: Record<number, T>) {
  return {
    value(index: number): T | undefined {
      return values[index];
    },
  };
}

function ligandLoci(overrides: { labelAsymId?: string; compId?: string } = {}): Loci {
  return residueLoci({
    labelAsymId: overrides.labelAsymId ?? 'LB',
    authAsymId: 'A',
    entityId: '9',
    compId: overrides.compId ?? 'NAG',
    authSeqId: 701,
    operator: 'ASM_2',
  });
}

function proteinLoci(
  overrides: {
    labelAsymId?: string;
    authAsymId?: string;
    entityId?: string;
    compId?: string;
    authSeqId?: number;
    operator?: string;
  } = {}
): Loci {
  return residueLoci({
    labelAsymId: overrides.labelAsymId ?? 'A',
    authAsymId: overrides.authAsymId ?? 'H',
    entityId: overrides.entityId ?? '1',
    compId: overrides.compId ?? 'MET',
    authSeqId: overrides.authSeqId ?? 31,
    operator: overrides.operator ?? 'ASM_1',
  });
}

function residueLoci({
  labelAsymId,
  authAsymId,
  entityId,
  compId,
  authSeqId,
  operator,
}: {
  labelAsymId: string;
  authAsymId: string;
  entityId: string;
  compId: string;
  authSeqId: number;
  operator: string;
}): Loci {
  const atomIndex = 42;
  const residueIndex = 5;
  const chainIndex = 2;
  const unit = {
    id: 'unit-1',
    elements: [atomIndex],
    residueIndex: { [atomIndex]: residueIndex },
    chainIndex: { [atomIndex]: chainIndex },
    conformation: { operator: { name: operator } },
    model: {
      atomicHierarchy: {
        chains: {
          label_asym_id: table({ [chainIndex]: labelAsymId }),
          auth_asym_id: table({ [chainIndex]: authAsymId }),
          label_entity_id: table({ [chainIndex]: entityId }),
        },
        residues: {
          auth_seq_id: table({ [residueIndex]: authSeqId }),
        },
        atoms: {
          label_comp_id: table({ [atomIndex]: compId }),
        },
      },
    },
  };

  return {
    kind: 'element-loci',
    structure: {},
    elements: [{ unit, indices: OrderedSet.ofSingleton(0) }],
  } as unknown as Loci;
}

function pickedBondLoci(a: Loci, b: Loci = a): Loci {
  if (!StructureElement.Loci.is(a) || !StructureElement.Loci.is(b))
    throw Error('Element fixtures required');
  const first = a.elements[0];
  const second = b.elements[0];
  const aIndex = OrderedSet.getAt(first.indices, 0);
  const bIndex = OrderedSet.getAt(second.indices, 0);
  return Bond.Loci(a.structure, [
    Bond.Location(a.structure, first.unit, aIndex, a.structure, second.unit, bIndex),
    Bond.Location(a.structure, second.unit, bIndex, a.structure, first.unit, aIndex),
  ]);
}

describe('useMolstarInteraction ligand loci boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (
      window as typeof window & {
        __WAYPOINT_MOLSTAR_INTERACTION_CLICK__?: unknown;
        __WAYPOINT_MOLSTAR_INTERACTION_HOVER__?: unknown;
      }
    ).__WAYPOINT_MOLSTAR_INTERACTION_CLICK__;
    delete (
      window as typeof window & {
        __WAYPOINT_MOLSTAR_INTERACTION_CLICK__?: unknown;
        __WAYPOINT_MOLSTAR_INTERACTION_HOVER__?: unknown;
      }
    ).__WAYPOINT_MOLSTAR_INTERACTION_HOVER__;
  });

  it.each([
    ['protein side chain', () => proteinLoci()],
    ['glycan with distinct label/auth chain and assembly operator', () => ligandLoci()],
  ])('extracts the identical identity from a %s sphere and stick', (_name, fixture) => {
    const atom = fixture();
    expect(extractResidueFromLoci(pickedBondLoci(atom))).toEqual(extractResidueFromLoci(atom));
  });

  it('uses the picked half of an inter-residue bond rather than sorting its endpoints', () => {
    const peptide = proteinLoci({ labelAsymId: 'C', authAsymId: 'C', authSeqId: 7, compId: 'THR' });
    const glycan = ligandLoci({ labelAsymId: 'D', compId: 'A2G' });
    expect(extractResidueFromLoci(pickedBondLoci(peptide, glycan))).toEqual(
      extractResidueFromLoci(peptide)
    );
    expect(extractResidueFromLoci(pickedBondLoci(glycan, peptide))).toEqual(
      extractResidueFromLoci(glycan)
    );
  });

  it('interprets native bond indices as unit-local indices', () => {
    const atom = proteinLoci();
    if (!StructureElement.Loci.is(atom)) throw Error('Element fixture required');
    const unit = { ...atom.elements[0].unit, elements: [-1, 42] };
    const shifted = StructureElement.Loci(atom.structure, [
      { unit, indices: OrderedSet.ofSingleton(1) },
    ]);
    expect(extractResidueFromLoci(pickedBondLoci(shifted))).toEqual(extractResidueFromLoci(atom));
  });

  it('does not clear hover when moving from a residue sphere to its stick and selects that stick', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hover = createSubscription<HoverEvent>();
    const click = createSubscription<ClickEvent>();
    const onHover = vi.fn();
    const onClick = vi.fn();
    const plugin = { behaviors: { interaction: { hover, click } } };
    renderHook(() => useMolstarInteraction(plugin, { onHover, onClick }));
    const atom = ligandLoci();
    const bond = pickedBondLoci(atom);
    act(() => {
      hover.emit({ current: { loci: atom } });
      frames.shift()?.(0);
    });
    act(() => {
      hover.emit({ current: { loci: bond } });
      frames.shift()?.(16);
    });
    act(() => {
      click.emit({ current: { loci: bond }, buttons: 1, modifiers: { meta: true } });
    });
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenLastCalledWith(extractResidueFromLoci(atom));
    expect(onClick).toHaveBeenCalledWith(extractResidueFromLoci(atom), 'toggle');
  });

  it('extracts scoped ligand metadata from Molstar loci', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(extractResidueFromLoci(ligandLoci())).toEqual({
      chain: 'LB2',
      position: 701,
      baseChain: 'LB',
      labelAsymId: 'LB',
      authAsymId: 'A',
      entityId: '9',
      operator: 'ASM_2',
      compId: 'NAG',
      labelCompId: 'NAG',
    });
  });

  it('delivers scoped ligand hover and click events to callbacks', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hover = createSubscription<HoverEvent>();
    const click = createSubscription<ClickEvent>();
    const onHover = vi.fn();
    const onClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          hover,
          click,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onHover,
        onClick,
        shouldHandleResidue: (residue) => residue.labelAsymId === 'LB',
      })
    );

    const loci = ligandLoci();
    act(() => hover.emit({ current: { loci } }));
    act(() =>
      click.emit({
        current: { loci },
        buttons: 1,
        modifiers: { meta: true, shift: true },
      })
    );
    act(() =>
      click.emit({
        current: { loci: ligandLoci({ labelAsymId: 'LC' }) },
        buttons: 1,
        modifiers: { meta: true },
      })
    );

    expect(onHover).toHaveBeenCalledWith({
      chain: 'LB2',
      position: 701,
      baseChain: 'LB',
      labelAsymId: 'LB',
      authAsymId: 'A',
      entityId: '9',
      operator: 'ASM_2',
      compId: 'NAG',
      labelCompId: 'NAG',
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(
      {
        chain: 'LB2',
        position: 701,
        baseChain: 'LB',
        labelAsymId: 'LB',
        authAsymId: 'A',
        entityId: '9',
        operator: 'ASM_2',
        compId: 'NAG',
        labelCompId: 'NAG',
      },
      'range'
    );
  });

  it('treats auth/label/entity identity changes as hover changes even when chain and position match', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hover = createSubscription<HoverEvent>();
    const onHover = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          hover,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onHover,
      })
    );

    act(() => {
      hover.emit({ current: { loci: proteinLoci({ authAsymId: 'H' }) } });
      frames.shift()?.(0);
    });
    act(() => {
      hover.emit({ current: { loci: proteinLoci({ authAsymId: 'I' }) } });
      frames.shift()?.(16);
    });

    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover.mock.calls[0][0]).toMatchObject({
      chain: 'A',
      position: 31,
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
    });
    expect(onHover.mock.calls[1][0]).toMatchObject({
      chain: 'A',
      position: 31,
      labelAsymId: 'A',
      authAsymId: 'I',
      entityId: '1',
    });
  });

  it('does not process residue hover while primary-button canvas drag is manipulating the camera', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hover = createSubscription<HoverEvent>();
    const onHover = vi.fn();
    const canvas = document.createElement('canvas');
    const plugin = {
      canvas3d: {
        webgl: {
          gl: { canvas },
        },
      },
      behaviors: {
        interaction: {
          hover,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onHover,
      })
    );

    act(() => {
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 31 }) } });
      frames.shift()?.(0);
    });
    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onHover).toHaveBeenLastCalledWith(expect.objectContaining({ position: 31 }));

    act(() => {
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 32 }) } });
    });
    expect(frames).toHaveLength(1);

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    });
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenLastCalledWith(null);

    act(() => {
      frames.shift()?.(16);
    });
    expect(onHover).toHaveBeenCalledTimes(2);

    act(() => {
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 32 }) } });
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 33 }) } });
    });
    expect(frames).toHaveLength(0);
    expect(onHover).toHaveBeenCalledTimes(2);

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 34 }) } });
      frames.shift()?.(16);
    });
    expect(onHover).toHaveBeenCalledTimes(3);
    expect(onHover).toHaveBeenLastCalledWith(expect.objectContaining({ position: 34 }));
  });

  it('suppresses a pending zero-button hover while the canvas still has an active press', () => {
    const scheduleFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', scheduleFrame);
    const hover = createSubscription<HoverEvent>();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'matches').mockImplementation((selector) => selector === ':active');
    renderHook(() =>
      useMolstarInteraction(
        { canvas3d: { webgl: { gl: { canvas } } }, behaviors: { interaction: { hover } } },
        { onHover: vi.fn() }
      )
    );
    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, buttons: 1 }));
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 32 }) }, buttons: 0 });
    });
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it('recovers hover when the viewer reports released buttons after a missed pointer-up', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const hover = createSubscription<HoverEvent>();
    const onHover = vi.fn();
    const canvas = document.createElement('canvas');
    const plugin = {
      canvas3d: { webgl: { gl: { canvas } } },
      behaviors: { interaction: { hover } },
    };
    renderHook(() => useMolstarInteraction(plugin, { onHover }));
    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, buttons: 1 }));
      hover.emit({ current: { loci: proteinLoci({ authSeqId: 32 }) }, buttons: 0 });
      frames.shift()?.(0);
    });
    expect(onHover).toHaveBeenLastCalledWith(expect.objectContaining({ position: 32 }));
  });

  it('selects protein residues on selection gestures and preserves label/auth chain identity', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const hover = createSubscription<HoverEvent>();
    const click = createSubscription<ClickEvent>();
    const onClick = vi.fn();
    const onFocusClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          hover,
          click,
        },
      },
    };
    const loci = proteinLoci();

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onClick,
        onFocusClick,
        shouldHandleResidue: (residue) => residue.labelAsymId === 'A',
      })
    );

    act(() =>
      click.emit({
        current: { loci },
        buttons: 1,
        modifiers: {},
      })
    );
    expect(onClick).not.toHaveBeenCalled();
    expect(onFocusClick).toHaveBeenCalledTimes(1);
    expect(onFocusClick).toHaveBeenCalledWith(loci);

    act(() =>
      click.emit({
        current: { loci },
        buttons: 1,
        modifiers: { meta: true },
      })
    );
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenLastCalledWith(
      {
        chain: 'A',
        position: 31,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
        labelCompId: 'MET',
      },
      'toggle'
    );
    expect(onFocusClick).toHaveBeenCalledTimes(1);

    act(() =>
      click.emit({
        current: { loci },
        buttons: 1,
        modifiers: { shift: true },
      })
    );
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onClick).toHaveBeenLastCalledWith(
      {
        chain: 'A',
        position: 31,
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
        labelCompId: 'MET',
      },
      'range'
    );

    act(() =>
      click.emit({
        current: { loci },
        buttons: 2,
        modifiers: { meta: true },
      })
    );
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onFocusClick).toHaveBeenCalledTimes(1);

    act(() =>
      click.emit({
        current: { loci: proteinLoci({ labelAsymId: 'B' }) },
        buttons: 1,
        modifiers: { meta: true },
      })
    );
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not focus or select when Molstar reports a released secondary click as buttons=0, button=2', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const click = createSubscription<ClickEvent>();
    const onClick = vi.fn();
    const onFocusClick = vi.fn();
    const onBlankPrimaryClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          click,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onClick,
        onFocusClick,
        onBlankPrimaryClick,
      })
    );

    act(() =>
      click.emit({
        current: { loci: proteinLoci({ authSeqId: 402, compId: 'GLU' }) },
        buttons: 0,
        button: 2,
        modifiers: {},
      })
    );

    expect(onClick).not.toHaveBeenCalled();
    expect(onFocusClick).not.toHaveBeenCalled();
    expect(onBlankPrimaryClick).not.toHaveBeenCalled();
  });

  it('retains authoritative label_comp_id identity for a standard polymer residue', () => {
    expect(extractResidueFromLoci(proteinLoci({ authSeqId: 402, compId: 'GLU' }))).toMatchObject({
      chain: 'A',
      position: 402,
      labelCompId: 'GLU',
    });
  });

  it('routes unmodified primary empty-loci clicks to blank camera reset only', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const click = createSubscription<ClickEvent>();
    const onClick = vi.fn();
    const onFocusClick = vi.fn();
    const onBlankPrimaryClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          click,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onClick,
        onFocusClick,
        onBlankPrimaryClick,
      })
    );

    act(() =>
      click.emit({
        current: { loci: MolstarLoci.Empty },
        buttons: 1,
        modifiers: {},
      })
    );

    expect(onBlankPrimaryClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onFocusClick).not.toHaveBeenCalled();
    expect(
      (
        window as typeof window & {
          __WAYPOINT_MOLSTAR_INTERACTION_CLICK__?: {
            last?: { stage?: string; calledBlankPrimaryClick?: boolean; isEmptyLoci?: boolean };
          };
        }
      ).__WAYPOINT_MOLSTAR_INTERACTION_CLICK__?.last
    ).toMatchObject({
      stage: 'blank-primary-click-reset-camera',
      calledBlankPrimaryClick: true,
      isEmptyLoci: true,
    });
  });

  it('does not route residue clicks to blank camera reset', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const click = createSubscription<ClickEvent>();
    const onFocusClick = vi.fn();
    const onBlankPrimaryClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          click,
        },
      },
    };
    const loci = proteinLoci();

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onFocusClick,
        onBlankPrimaryClick,
      })
    );

    act(() =>
      click.emit({
        current: { loci },
        buttons: 1,
        modifiers: {},
      })
    );

    expect(onFocusClick).toHaveBeenCalledTimes(1);
    expect(onFocusClick).toHaveBeenCalledWith(loci);
    expect(onBlankPrimaryClick).not.toHaveBeenCalled();
  });

  it('does not reset camera for modified empty-loci clicks', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const click = createSubscription<ClickEvent>();
    const onBlankPrimaryClick = vi.fn();
    const plugin = {
      behaviors: {
        interaction: {
          click,
        },
      },
    };

    renderHook(() =>
      useMolstarInteraction(plugin, {
        onBlankPrimaryClick,
      })
    );

    act(() =>
      click.emit({
        current: { loci: MolstarLoci.Empty },
        buttons: 1,
        modifiers: { meta: true },
      })
    );
    act(() =>
      click.emit({
        current: { loci: MolstarLoci.Empty },
        buttons: 2,
        modifiers: {},
      })
    );

    expect(onBlankPrimaryClick).not.toHaveBeenCalled();
  });

  it('classifies DOM canvas points through MolStar picking instead of DOM target guesses', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      top: 80,
      width: 200,
      height: 100,
      right: 250,
      bottom: 180,
      x: 50,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect);
    const identify = vi.fn(() => ({ id: { objectId: 1, groupId: 2, instanceId: 3 } }));
    const getLoci = vi.fn(() => ({ loci: proteinLoci() }));
    const plugin = {
      canvas3d: {
        identify,
        getLoci,
      },
    };

    expect(classifyMolstarCanvasPoint(plugin, canvas, 75, 110)).toBe('non-empty');
    expect(identify).toHaveBeenCalledTimes(1);
    expect(Array.from(identify.mock.calls[0][0])).toEqual([25, 30]);
    expect(residueAtMolstarCanvasPoint(plugin, canvas, 75, 110)).toMatchObject({
      chain: 'A',
      position: 31,
      labelCompId: 'MET',
    });

    getLoci.mockReturnValueOnce({ loci: MolstarLoci.Empty });
    expect(classifyMolstarCanvasPoint(plugin, canvas, 75, 110)).toBe('empty');
    expect(classifyMolstarCanvasPoint(plugin, document.createElement('div'), 75, 110)).toBe(
      'unknown'
    );
  });
});
