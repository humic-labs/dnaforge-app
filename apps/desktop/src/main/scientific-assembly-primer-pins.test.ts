import { describe, expect, it } from 'vitest';
import {
  assertAssemblyPrimerPins,
  declaredAssemblyOligos,
  type AssemblyPrimerPinSelection,
  type AssemblyPrimerRecipeEntry,
} from './scientific-assembly-primer-pins';

const FORWARD = 'AGAGGAGAAATACTAATGAGTTTATGGAAAAAAATCAGCCTCGG';
const REVERSE = 'TTATTTGATGCCTGGAAACTCGAACTGATAGAGCAAATCCAGT';

function recipe(id: string, name: string, sequence: string): AssemblyPrimerRecipeEntry {
  return { id, name, sequence };
}

function pin(resourceId: string, name: string, bases: string): AssemblyPrimerPinSelection {
  return { resourceId, name, bases: bases.toUpperCase() };
}

describe('assembly primer pins', () => {
  it('accepts primers the assembly wrote under their own names', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD), recipe('p-r', 'F1-rev', REVERSE)],
        selections: [pin('res-f', 'F1-fwd', FORWARD), pin('res-r', 'F1-rev', REVERSE)],
        declared: [],
      })
    ).not.toThrow();
  });

  it('refuses a pin whose bases are not in the recipe', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD)],
        selections: [pin('res-f', 'F1-fwd', `${FORWARD}AAAA`)],
        declared: [],
      })
    ).toThrow('do not match its native recipe');
  });

  it('accepts a declared oligo saved under a different name', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD)],
        selections: [pin('oligo-380', 'oPC-0147', FORWARD)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).not.toThrow();
  });

  it('refuses when a declared oligo is not pinned at all', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD)],
        selections: [pin('res-other', 'F1-fwd', FORWARD)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).toThrow('does not pin the saved oligo its native recipe declares');
  });

  it('refuses when a declared oligo no longer has the recipe bases', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD)],
        selections: [pin('oligo-380', 'oPC-0147', REVERSE)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).toThrow('does not have the bases its native recipe declares');
  });

  it('accepts two recipe primers that share one saved oligo', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-a', 'F1-fwd', FORWARD), recipe('p-b', 'F2-fwd', FORWARD)],
        selections: [pin('oligo-380', 'oPC-0147', FORWARD)],
        declared: [
          { primerId: 'p-a', oligoId: 'oligo-380' },
          { primerId: 'p-b', oligoId: 'oligo-380' },
        ],
      })
    ).not.toThrow();
  });

  it('refuses a stray pin that the recipe never declared', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD)],
        selections: [pin('oligo-380', 'oPC-0147', FORWARD), pin('res-x', 'Sneaky', REVERSE)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).toThrow('do not match its native recipe');
  });

  it('checks a declared oligo and an assembly-written primer together', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD), recipe('p-r', 'F1-rev', REVERSE)],
        selections: [pin('oligo-380', 'oPC-0147', FORWARD), pin('res-r', 'F1-rev', REVERSE)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).not.toThrow();
  });

  it('still names the assembly-written primer when its pin is renamed', () => {
    expect(() =>
      assertAssemblyPrimerPins({
        designed: [recipe('p-f', 'F1-fwd', FORWARD), recipe('p-r', 'F1-rev', REVERSE)],
        selections: [pin('oligo-380', 'oPC-0147', FORWARD), pin('res-r', 'Renamed', REVERSE)],
        declared: [{ primerId: 'p-f', oligoId: 'oligo-380' }],
      })
    ).toThrow('do not match its native recipe');
  });

  it('reads declared oligos defensively', () => {
    expect(declaredAssemblyOligos(undefined)).toEqual([]);
    expect(declaredAssemblyOligos('nonsense')).toEqual([]);
    expect(
      declaredAssemblyOligos([
        { primerId: 'p-f', oligoId: 'oligo-380', artifactRevision: 4 },
        { primerId: 'p-r' },
        null,
        42,
      ])
    ).toEqual([{ primerId: 'p-f', oligoId: 'oligo-380' }]);
  });
});
