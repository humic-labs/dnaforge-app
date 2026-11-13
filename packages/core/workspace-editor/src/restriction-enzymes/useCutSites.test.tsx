/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { countCutSites, findCutSites } from '@waypoint/sequence-utils';
import { useCutSites } from './useCutSites';

const TEST_ENZYMES: RestrictionEnzyme[] = [
  {
    name: 'EcoRI',
    recognition_sequence: 'GAATTC',
    recognition_sequence_length: 6,
    cut_position_top: 1,
    cut_position_bottom: 5,
    overhang_type: '5_prime',
    overhang_length: 4,
    enzyme_type: 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [{ code: 'N', name: 'NEB', catalog_number: null, product_url: null }],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  },
  {
    name: 'BamHI',
    recognition_sequence: 'GGATCC',
    recognition_sequence_length: 6,
    cut_position_top: 1,
    cut_position_bottom: 5,
    overhang_type: '5_prime',
    overhang_length: 4,
    enzyme_type: 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [{ code: 'N', name: 'NEB', catalog_number: null, product_url: null }],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  },
  {
    name: 'A-Cutter',
    recognition_sequence: 'A',
    recognition_sequence_length: 1,
    cut_position_top: 0,
    cut_position_bottom: 1,
    overhang_type: null,
    overhang_length: null,
    enzyme_type: 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [{ code: 'N', name: 'NEB', catalog_number: null, product_url: null }],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  },
];

vi.mock('@waypoint/sequence-utils', async () => {
  const actual = await vi.importActual<typeof import('@waypoint/sequence-utils')>(
    '@waypoint/sequence-utils'
  );
  return {
    ...actual,
    loadAllEnzymes: vi.fn(async () => TEST_ENZYMES),
    countCutSites: vi.fn(actual.countCutSites),
    findCutSites: vi.fn(actual.findCutSites),
  };
});

describe('useCutSites scoped persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(countCutSites).mockClear();
    vi.mocked(findCutSites).mockClear();
  });

  it('keeps active restriction enzymes isolated by sequence scope', async () => {
    const { result, rerender } = renderHook(({ sequence, scope }) => useCutSites(sequence, scope), {
      initialProps: {
        sequence: 'AAAAGAATTCAAAA',
        scope: 'sequence-a',
      },
    });

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    const ecoRI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'EcoRI');
    expect(ecoRI).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(ecoRI!);
    });

    await waitFor(() =>
      expect(localStorage.getItem('waypoint-active-enzymes:sequence-a')).toBe('["EcoRI"]')
    );
    expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual(['EcoRI']);
    await waitFor(() => expect(result.current[0].cutSites).toHaveLength(1));

    rerender({
      sequence: 'GAATTC'.repeat(1000),
      scope: 'sequence-b',
    });

    expect(result.current[0].activeEnzymes).toEqual([]);
    expect(result.current[0].cutSites).toEqual([]);
    expect(localStorage.getItem('waypoint-active-enzymes:sequence-b')).not.toBe('["EcoRI"]');

    await waitFor(() =>
      expect(localStorage.getItem('waypoint-active-enzymes:sequence-b')).toBe('[]')
    );

    const bamHI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'BamHI');
    expect(bamHI).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(bamHI!);
    });

    await waitFor(() =>
      expect(localStorage.getItem('waypoint-active-enzymes:sequence-b')).toBe('["BamHI"]')
    );

    rerender({
      sequence: 'AAAAGAATTCAAAA',
      scope: 'sequence-a',
    });

    await waitFor(() =>
      expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual(['EcoRI'])
    );
    await waitFor(() => expect(result.current[0].cutSites).toHaveLength(1));
  });

  it('keeps legacy unscoped persistence on the original global key', async () => {
    const { result } = renderHook(() => useCutSites('AAAAGAATTCAAAA'));

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    const ecoRI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'EcoRI');
    expect(ecoRI).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(ecoRI!);
    });

    await waitFor(() => expect(localStorage.getItem('waypoint-active-enzymes')).toBe('["EcoRI"]'));
    expect(findCutSites('AAAAGAATTCAAAA', ecoRI!)).toHaveLength(1);
    await waitFor(() => expect(result.current[0].cutSites).toHaveLength(1));
  });

  it('applies source display requests after loading, replacing hidden enzymes only in this scope', async () => {
    localStorage.setItem('waypoint-active-enzymes:source', '["A-Cutter"]');
    localStorage.setItem('waypoint-enzyme-visible:source', 'false');
    localStorage.setItem('waypoint-active-enzymes:other', '["A-Cutter"]');
    const applied = vi.fn();
    const { result, rerender } = renderHook(
      ({ request }) =>
        useCutSites('GAATTCGGATCC', 'source', {
          displayRequest: request,
          onDisplayRequestApplied: applied,
        }),
      { initialProps: { request: { id: 'open-1', enzymeNames: ['EcoRI', 'BamHI', 'EcoRI'] } } }
    );

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual([
      'EcoRI',
      'BamHI',
    ]);
    expect(result.current[0].isVisible).toBe(true);
    await waitFor(() => expect(result.current[0].cutSites).toHaveLength(2));
    expect(localStorage.getItem('waypoint-active-enzymes:other')).toBe('["A-Cutter"]');
    expect(applied).toHaveBeenCalledExactlyOnceWith('open-1');

    act(() => result.current[1].removeEnzyme('BamHI'));
    rerender({ request: { id: 'open-1', enzymeNames: ['EcoRI', 'BamHI', 'EcoRI'] } });
    expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual(['EcoRI']);
    act(() => result.current[1].toggleVisibility());
    rerender({ request: { id: 'open-2', enzymeNames: ['BamHI'] } });
    expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual(['BamHI']);
    expect(result.current[0].isVisible).toBe(true);
  });

  it('does not hide an explicitly requested source enzyme behind a different vendor filter', async () => {
    localStorage.setItem('waypoint-enzyme-vendor', 'B');
    const { result, unmount } = renderHook(() =>
      useCutSites('GAATTC', 'source', {
        displayRequest: { id: 'open', enzymeNames: ['EcoRI'] },
      })
    );
    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    expect(result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual(['EcoRI']);
    await waitFor(() => expect(result.current[0].cutSites).toHaveLength(1));
    expect(localStorage.getItem('waypoint-enzyme-vendor')).toBe('B');
    unmount();
    const reopened = renderHook(() => useCutSites('GAATTC', 'source'));
    await waitFor(() => expect(reopened.result.current[0].isLoading).toBe(false));
    expect(reopened.result.current[0].activeEnzymes.map((enzyme) => enzyme.name)).toEqual([
      'EcoRI',
    ]);
    act(() => reopened.result.current[1].clearAllEnzymes());
    expect(reopened.result.current[0].activeEnzymes).toEqual([]);
  });

  it('routes single-cutter preview through the async scanner instead of synchronous render scans', async () => {
    const { result } = renderHook(() => useCutSites('AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA'));

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));

    act(() => {
      result.current[1].setCutterFilter('single');
    });

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();

    await waitFor(
      () => {
        expect(result.current[0].scannedCutSites.map((site) => site.enzyme.name).sort()).toEqual([
          'EcoRI',
        ]);
      },
      { timeout: 2000 }
    );

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();

    act(() => {
      result.current[1].setCutterFilter('double');
    });

    await waitFor(
      () => {
        expect(result.current[0].scannedCutSites.map((site) => site.enzyme.name).sort()).toEqual([
          'BamHI',
          'BamHI',
        ]);
      },
      { timeout: 2000 }
    );

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();
  });

  it('previews single AND double cutters when the filter is single-double', async () => {
    const { result } = renderHook(() => useCutSites('AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA'));

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));

    act(() => {
      result.current[1].setCutterFilter('single-double');
    });

    await waitFor(
      () => {
        expect(result.current[0].scannedCutSites.map((site) => site.enzyme.name).sort()).toEqual([
          'BamHI',
          'BamHI',
          'EcoRI',
        ]);
      },
      { timeout: 2000 }
    );

    const countByEnzyme = new Map<string, number>();
    for (const site of result.current[0].scannedCutSites) {
      countByEnzyme.set(site.enzyme.name, (countByEnzyme.get(site.enzyme.name) ?? 0) + 1);
    }
    for (const count of countByEnzyme.values()) {
      expect(count === 1 || count === 2).toBe(true);
    }
  });

  it('keeps active enzymes out of the single/double cutter preview overlay', async () => {
    const { result } = renderHook(() => useCutSites('AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA'));

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    const ecoRI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'EcoRI');
    expect(ecoRI).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(ecoRI!);
      result.current[1].setCutterFilter('single');
    });

    await waitFor(
      () => {
        expect(result.current[0].scanPhase).toBe('complete');
        expect(result.current[0].enzymeCutCountPhase).toBe('complete');
      },
      { timeout: 2500 }
    );

    expect(result.current[0].cutSites.map((site) => site.enzyme.name)).toEqual(['EcoRI']);
    expect(result.current[0].scannedCutSites.map((site) => site.enzyme.name)).not.toContain(
      'EcoRI'
    );
    expect(result.current[0].scannedCutSites).toHaveLength(0);
    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();
  });

  it('computes capped catalog counts only when the enzyme UI asks for them', async () => {
    const sequence = 'AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA';
    const { result, rerender } = renderHook(
      ({ enabled }) => useCutSites(sequence, undefined, { catalogSummaryEnabled: enabled }),
      {
        initialProps: { enabled: false },
      }
    );

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    expect(result.current[0].enzymeCutCountPhase).toBe('idle');
    expect(result.current[0].enzymeCutCounts.size).toBe(0);
    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(
      () => {
        expect(result.current[0].enzymeCutCountPhase).toBe('complete');
        expect(result.current[0].enzymeCutCounts.get('EcoRI')).toEqual({
          count: 1,
          capped: false,
        });
        expect(result.current[0].enzymeCutCounts.get('BamHI')).toEqual({
          count: 2,
          capped: false,
        });
        expect(result.current[0].enzymeCutCounts.get('A-Cutter')).toEqual({
          count: 10,
          capped: true,
        });
      },
      { timeout: 2500 }
    );

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();
  });

  it('does not restart the catalog preview count scan when an enzyme is activated', async () => {
    const sequence = 'AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA';
    const { result } = renderHook(() =>
      useCutSites(sequence, undefined, { catalogSummaryEnabled: true })
    );

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));
    await waitFor(
      () => {
        expect(result.current[0].enzymeCutCountPhase).toBe('complete');
        expect(result.current[0].enzymeCutCounts.get('EcoRI')).toEqual({
          count: 1,
          capped: false,
        });
      },
      { timeout: 2500 }
    );

    const ecoRI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'EcoRI');
    expect(ecoRI).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(ecoRI!);
    });

    expect(result.current[0].enzymeCutCountPhase).toBe('complete');
    expect(result.current[0].enzymeCutCounts.get('EcoRI')).toEqual({
      count: 1,
      capped: false,
    });
    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();
  });

  it('routes multiple active enzymes, including dense cutters, through the async scanner', async () => {
    const sequence = 'AAAAGAATTCAAAAGGATCCAAAAGGATCCAAAA';
    const { result } = renderHook(() => useCutSites(sequence));

    await waitFor(() => expect(result.current[0].isLoading).toBe(false));

    const ecoRI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'EcoRI');
    const bamHI = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'BamHI');
    const aCutter = result.current[0].availableEnzymes.find((enzyme) => enzyme.name === 'A-Cutter');
    expect(ecoRI).toBeDefined();
    expect(bamHI).toBeDefined();
    expect(aCutter).toBeDefined();

    act(() => {
      result.current[1].addEnzyme(ecoRI!);
      result.current[1].addEnzyme(bamHI!);
      result.current[1].addEnzyme(aCutter!);
    });

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();

    await waitFor(
      () => {
        expect(result.current[0].scanPhase).toBe('complete');
        const counts = new Map<string, number>();
        for (const site of result.current[0].cutSites) {
          counts.set(site.enzyme.name, (counts.get(site.enzyme.name) ?? 0) + 1);
        }
        expect(counts.get('EcoRI')).toBe(1);
        expect(counts.get('BamHI')).toBe(2);
        expect(counts.get('A-Cutter')).toBeGreaterThan(10);
        expect(result.current[0].enzymeCutCounts.get('EcoRI')).toEqual({
          count: 1,
          capped: false,
        });
        expect(result.current[0].enzymeCutCounts.get('BamHI')).toEqual({
          count: 2,
          capped: false,
        });
        expect(result.current[0].enzymeCutCounts.get('A-Cutter')?.count).toBeGreaterThan(10);
        expect(result.current[0].enzymeCutCounts.get('A-Cutter')?.capped).toBe(false);
      },
      { timeout: 2500 }
    );

    expect(countCutSites).not.toHaveBeenCalled();
    expect(findCutSites).not.toHaveBeenCalled();
  });
});
