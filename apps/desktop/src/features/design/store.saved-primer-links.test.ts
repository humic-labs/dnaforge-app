import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../junction-workbench/public/AssemblyWorkbenchReducer';
import type { AssemblyWorkbenchCommand } from '../junction-workbench/public/AssemblyWorkbenchContract';
import { assemblyPrimerUses, type SavedPrimerLink } from './saved-primer-links';
import { hydrateDesign, partializeDesigns, useDesignStore } from './store';
import type { DesignRegion, SequenceDesign } from './types';

const LEFT =
  'ATGGCTAGCAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTGTCAGTGGAGAGGGTGAAGGTGATGCTACATACGGAAAGCTTACCCTTAAATTTATTTGCACTACTGGAAAACTACCTGTTCCATGGCCAACACTTGTCACTACTTTCTCTTATGGTGTTCAATGCTTTTCCCGTTATCCGGATCACATGAAACGGC';
const RIGHT =
  'GCATGACTTTTTCAAGAGTGCCATGCCCGAAGGTTATGTACAGGAACGCACTATATCTTTCAAAGATGACGGGAACTACAAGACGCGTGCTGAAGTCAAGTTTGAAGGTGATACCCTTGTTAATCGTATCGAGTTAAAAGGTATTGATTTTAAAGAAGATGGAAACATTCTCGGACACAAACTCGAGTACAACTATAACTCACACAATGTATACATCACGGCAGACAAACAAAAGAATG';

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 100,
    sourceEnd: 100 + sequence.length,
    sourceLength: 5000,
    sourceIsCircular: true,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function stored(designId: string): SequenceDesign {
  return useDesignStore.getState().designs[designId]!;
}

function apply(designId: string, command: AssemblyWorkbenchCommand): void {
  const design = stored(designId);
  const result = applyAssemblyWorkbenchCommand({
    design,
    viewState: createAssemblyWorkbenchViewState(design),
    command,
  });
  expect(result.status === 'applied' ? [] : result.errors).toEqual([]);
  if (result.status !== 'applied') return;
  expect(
    useDesignStore.getState().commitWorkbenchDesign(designId, result.nextDesign, design.version)
  ).toBe(true);
}

function draftedDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Linked primers', 'circular', 'gibson');
  store.addRegion(designId, region('left', LEFT));
  store.addRegion(designId, region('right', RIGHT));
  apply(designId, { type: 'draftAssembly', expectedDesignVersion: stored(designId).version });
  expect(stored(designId).designPrimers).toHaveLength(2);
  return designId;
}

function linksFor(design: SequenceDesign): SavedPrimerLink[] {
  return assemblyPrimerUses(design).map((use, index) => ({
    primerId: use.primerId,
    oligoId: `oligo-${index}`,
    artifactRevision: 2,
    sequenceContentHash: `hash-${index}`,
    linkedAtDesignVersion: design.version,
    linkedAt: '2026-11-10T12:00:00.000Z',
    via: 'matched-existing',
  }));
}

describe('saved primer links in the design store', () => {
  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  });

  it('records links without changing the design version and ignores an identical write', () => {
    const designId = draftedDesign();
    const version = stored(designId).version;
    const links = linksFor(stored(designId));

    expect(useDesignStore.getState().setSavedPrimerLinks(designId, links)).toBe(true);
    expect(stored(designId).savedPrimerLinks).toEqual(links);
    expect(stored(designId).version).toBe(version);
    expect(useDesignStore.getState().setSavedPrimerLinks(designId, [...links])).toBe(false);
    expect(useDesignStore.getState().setSavedPrimerLinks('missing', links)).toBe(false);
  });

  it('keeps links through primer edits and a redraft', () => {
    const designId = draftedDesign();
    const links = linksFor(stored(designId));
    useDesignStore.getState().setSavedPrimerLinks(designId, links);
    const forward = stored(designId).designPrimers[0]!.forward;

    apply(designId, {
      type: 'setPrimerPbsLength',
      primerId: forward.id,
      fragmentIndex: forward.fragmentIndex,
      direction: forward.direction,
      length: forward.pbs.sequence.length + 2,
      expectedDesignVersion: stored(designId).version,
    });
    expect(stored(designId).savedPrimerLinks).toEqual(links);

    apply(designId, {
      type: 'setPrimerContent',
      designId,
      primerId: forward.id,
      expectedDesignVersion: stored(designId).version,
      overhangSequence: 'acgtacgtacgt',
    });
    expect(stored(designId).savedPrimerLinks).toEqual(links);

    apply(designId, { type: 'draftAssembly', expectedDesignVersion: stored(designId).version });
    expect(stored(designId).savedPrimerLinks).toEqual(links);
    expect(stored(designId).designPrimers[0]!.forward.id).toBe(forward.id);
  });

  it('persists links and restores them on hydration', () => {
    const designId = draftedDesign();
    const links = linksFor(stored(designId));
    useDesignStore.getState().setSavedPrimerLinks(designId, links);

    const persisted = partializeDesigns(useDesignStore.getState().designs)[designId]!;
    expect(persisted.savedPrimerLinks).toEqual(links);
    const reopened = hydrateDesign(JSON.parse(JSON.stringify(persisted)) as SequenceDesign);
    expect(reopened.savedPrimerLinks).toEqual(links);
    expect(assemblyPrimerUses(reopened).map((use) => use.primerId)).toEqual(
      links.map((link) => link.primerId)
    );
  });
});
