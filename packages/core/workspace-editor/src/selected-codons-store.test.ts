// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  createSelectedCodonsStore,
  selectedCodonsToResidueSelections,
} from './selected-codons-store';
import { residueSelectionsToCodingDnaRanges } from './residue-selection-store';

describe('selectedCodonsStore', () => {
  it('starts empty', () => {
    const store = createSelectedCodonsStore();
    expect(store.getSnapshot()).toEqual([]);
  });

  it('stores residue selections and projects coding-DNA ranges for legacy renderers', () => {
    const store = createSelectedCodonsStore();
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [
        { start: 100, end: 102, strand: 1 },
        { start: 103, end: 105, strand: 1 },
      ])
    );
    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.getSnapshot()[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
      },
    });
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot(), '/fixtures/ref.gb')).toEqual([
      { start: 100, end: 102, strand: 1 },
      { start: 103, end: 105, strand: 1 },
    ]);
  });

  it('empty array writes coerce to a stable singleton (no `[] !== []` re-renders)', () => {
    const store = createSelectedCodonsStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    const a = store.getSnapshot();
    store.set([]);
    expect(notifications).toBe(0);
    const b = store.getSnapshot();
    expect(b).toBe(a);
    store.set([]);
    expect(notifications).toBe(0);
  });

  it('dedups identical selections (order-sensitive)', () => {
    const store = createSelectedCodonsStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    const selection = selectedCodonsToResidueSelections('/fixtures/ref.gb', [
      { start: 100, end: 102, strand: 1 },
    ]);
    store.set(selection);
    store.set(selection);
    expect(notifications).toBe(1);
  });

  it('updates when a residue target differs', () => {
    const store = createSelectedCodonsStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [{ start: 100, end: 102, strand: 1 }])
    );
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [{ start: 200, end: 202, strand: 1 }])
    );
    expect(notifications).toBe(2);
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot())[0].start).toBe(200);
  });

  it('updates when length differs', () => {
    const store = createSelectedCodonsStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [{ start: 100, end: 102, strand: 1 }])
    );
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [
        { start: 100, end: 102, strand: 1 },
        { start: 103, end: 105, strand: 1 },
      ])
    );
    expect(notifications).toBe(2);
  });

  it('clearing back to empty produces the same singleton reference', () => {
    const store = createSelectedCodonsStore();
    const before = store.getSnapshot();
    store.set(
      selectedCodonsToResidueSelections('/fixtures/ref.gb', [{ start: 100, end: 102, strand: 1 }])
    );
    store.set([]);
    const after = store.getSnapshot();
    expect(after).toBe(before);
  });
});
