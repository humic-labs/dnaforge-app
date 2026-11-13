import { reverseComplement } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';
import {
  assemblyPrimerUses,
  formatSourceSite,
  matchSavedOligos,
  mergeSavedPrimerLinks,
  oligoChemistryKey,
  savedPrimerLinkState,
  sourceAttachmentAgreement,
  type SavedOligoSnapshot,
  type SavedPrimerLink,
} from './saved-primer-links';
import type { DesignPrimer, DesignPrimerPair, DesignRegion, SequenceDesign } from './types';

const DESIGN_DEFAULTS = {
  topology: 'circular',
  assemblyState: 'ready',
  validationErrors: [],
  proposedPlans: [],
  defaultHomologyLength: 30,
  homologyRegions: [],
  selectedJunctionIndex: null,
  scrollToPosition: null,
  highlightRange: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies Partial<SequenceDesign>;

const BACKBONE_HEAD = 'TGCGTTTCTACAAACTCTTTTGTTTATTTTTCTAAATAC';
const BACKBONE_TAIL = 'TTTATCGCAACTCTCTACTGTTTCTCCAT';
const INSERT_HEAD = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';
const INSERT_TAIL = 'ACTGGATTTGCTCTATCAGTTCGAGTTT';

function region(
  id: string,
  head: string,
  tail: string,
  source: Pick<DesignRegion, 'sourceSequenceId' | 'sourceStart' | 'sourceEnd' | 'sourceLength'> & {
    regionLength: number;
  }
): DesignRegion {
  const filler = 'G'.repeat(source.regionLength - head.length - tail.length);
  return {
    id,
    sourceSequenceId: source.sourceSequenceId,
    sourceSequenceName: `source ${id}`,
    sourceStart: source.sourceStart,
    sourceEnd: source.sourceEnd,
    sourceLength: source.sourceLength,
    sourceIsCircular: true,
    sequence: `${head}${filler}${tail}`,
    annotations: [],
  };
}

function primer(
  id: string,
  fragmentIndex: number,
  direction: 'forward' | 'reverse',
  tail: string,
  binding: string
): DesignPrimer {
  return {
    id,
    name: `F${fragmentIndex + 1}-${direction === 'forward' ? 'fwd' : 'rev'}`,
    sequence: `${tail}${binding}`,
    pbs: { start: 0, end: binding.length, sequence: binding },
    overhang: { length: tail.length, sequence: tail, tailLength: tail.length },
    direction,
    fragmentIndex,
    junctionIndex: fragmentIndex,
    tm: 58.2,
  };
}

function design(): SequenceDesign {
  const pairs: DesignPrimerPair[] = [
    {
      fragmentIndex: 0,
      forward: primer('p0f', 0, 'forward', 'ctttctgcgtttata', BACKBONE_HEAD.toLowerCase()),
      reverse: primer('p0r', 0, 'reverse', 'gcggccgcgaattcc', reverseComplement(BACKBONE_TAIL)),
    },
    {
      fragmentIndex: 1,
      forward: primer('p1f', 1, 'forward', 'agaggagaaatacta', INSERT_HEAD.toLowerCase()),
      reverse: primer(
        'p1r',
        1,
        'reverse',
        'ttatttgatgcctggTTAGTGGTGGTGGTGGTGGTG',
        reverseComplement(INSERT_TAIL).toLowerCase()
      ),
    },
  ];
  return {
    ...DESIGN_DEFAULTS,
    id: 'design-1',
    name: 'pBAD33 TamB Gibson',
    version: 11,
    assemblyMethod: 'gibson',
    regions: [
      region('backbone', BACKBONE_HEAD, BACKBONE_TAIL, {
        sourceSequenceId: 'doc-backbone',
        sourceStart: 2896,
        sourceEnd: 1774,
        sourceLength: 5998,
        regionLength: 4876,
      }),
      region('insert', INSERT_HEAD, INSERT_TAIL, {
        sourceSequenceId: 'doc-genome',
        sourceStart: 518478,
        sourceEnd: 522255,
        sourceLength: 4641652,
        regionLength: 3777,
      }),
    ],
    spacers: [],
    designPrimers: pairs,
  };
}

function oligo(overrides: Partial<SavedOligoSnapshot> = {}): SavedOligoSnapshot {
  return {
    oligoId: 'oligo-1',
    catalogNumber: 'P380',
    name: 'TamB-Gibson-F3-F',
    bases: `AGAGGAGAAATACTA${INSERT_HEAD}`,
    sequenceContentHash: 'hash-1',
    artifactRevision: 4,
    chemistry: null,
    bindingSequence: null,
    tmC: 58.9,
    tmConcentrationNm: 500,
    tmModelLabel: 'Default (SantaLucia)',
    bindings: [],
    ...overrides,
  };
}

describe('assembly primer uses', () => {
  it('splits each primer into its 5-prime tail and binding part', () => {
    const uses = assemblyPrimerUses(design());
    expect(
      uses.map((use) => [use.primerId, use.tailSequence.length, use.bindingSequence.length])
    ).toEqual([
      ['p0f', 15, 39],
      ['p0r', 15, 29],
      ['p1f', 15, 29],
      ['p1r', 36, 28],
    ]);
    expect(uses[3]!.tailSequence).toBe('ttatttgatgcctggTTAGTGGTGGTGGTGGTGGTG');
    expect(uses[2]!.designVersion).toBe(11);
    expect(uses[2]!.partNumber).toBe(2);
  });

  it('maps forward and reverse binding sites onto source coordinates, across the origin', () => {
    const sites = assemblyPrimerUses(design()).map((use) => use.sourceSite);
    expect(sites.map((site) => [site?.documentId, site?.start, site?.end, site?.strand])).toEqual([
      ['doc-backbone', 2896, 2935, 1],
      ['doc-backbone', 1745, 1774, -1],
      ['doc-genome', 518478, 518507, 1],
      ['doc-genome', 522227, 522255, -1],
    ]);
    expect(sites.every((site) => site?.coordinateSystem === 'zero_based_half_open')).toBe(true);
    expect(formatSourceSite(sites[2]!)).toBe('518,479–518,507 (+)');
    expect(formatSourceSite(sites[1]!)).toBe('1,746–1,774 (−)');
  });

  it('reports a wrapping binding site and withholds a site it cannot place', () => {
    const wrapping = design();
    wrapping.regions[0] = { ...wrapping.regions[0]!, sourceStart: 5990 };
    const site = assemblyPrimerUses(wrapping)[0]!.sourceSite!;
    expect([site.start, site.end, site.wraps]).toEqual([5990, 31, true]);

    const edited = design();
    edited.designPrimers[1]!.forward = {
      ...edited.designPrimers[1]!.forward,
      pbs: { start: 0, end: 20, sequence: 'ACGTACGTACGTACGTACGT' },
    };
    expect(assemblyPrimerUses(edited)[2]!.sourceSite).toBeNull();
  });
});

describe('matching saved oligos', () => {
  const use = () => assemblyPrimerUses(design())[2]!;

  it('matches exact bases without regard to letter case', () => {
    expect(matchSavedOligos(use(), [oligo()])).toEqual({ kind: 'unique', oligo: oligo() });
    expect(matchSavedOligos(use(), [oligo({ bases: `${oligo().bases}A` })])).toEqual({
      kind: 'none',
    });
  });

  it('keeps oligos with different chemistry apart', () => {
    const biotinylated = oligo({
      oligoId: 'oligo-2',
      chemistry: {
        vendor: 'idt',
        notation: `/5Biosg/${oligo().bases}`,
        modifications: [
          {
            chemistryId: 'biotin',
            vendor: 'idt',
            vendorCode: '5Biosg',
            placement: 'five-prime',
            behavior: 'label',
            anchor: { kind: 'terminus', end: 'five-prime' },
          },
        ],
      } as never,
    });
    expect(matchSavedOligos(use(), [biotinylated])).toEqual({ kind: 'none' });
    expect(oligoChemistryKey({ vendor: 'idt', notation: 'ACGT', modifications: [] })).toBe('');
  });

  it('reports several identical saved oligos as ambiguous', () => {
    const match = matchSavedOligos(use(), [oligo(), oligo({ oligoId: 'oligo-9' })]);
    expect(match.kind).toBe('ambiguous');
  });
});

describe('saved primer link state', () => {
  const link: SavedPrimerLink = {
    primerId: 'p1f',
    oligoId: 'oligo-1',
    artifactRevision: 4,
    sequenceContentHash: 'hash-1',
    linkedAtDesignVersion: 11,
    linkedAt: '2026-11-10T00:00:00.000Z',
    via: 'matched-existing',
  };
  const use = () => assemblyPrimerUses(design())[2]!;

  it('stays current while bases and chemistry agree, even after an oligo revision', () => {
    expect(savedPrimerLinkState(use(), link, oligo({ artifactRevision: 5 }))).toBe('current');
  });

  it('names which side changed', () => {
    const editedDraft = { ...use(), sequence: `${use().sequence}a` };
    expect(savedPrimerLinkState(editedDraft, link, oligo())).toBe('draft-primer-changed');
    expect(
      savedPrimerLinkState(use(), link, oligo({ bases: 'ACGT', sequenceContentHash: 'hash-2' }))
    ).toBe('oligo-bases-changed');
    expect(savedPrimerLinkState(use(), link, null)).toBe('oligo-unavailable');
  });

  it('compares the derived source site with saved attachments', () => {
    const site = use().sourceSite;
    const binding = {
      id: 'binding-1',
      documentId: 'doc-genome',
      start: 518478,
      end: 518507,
      strand: 1 as const,
      placement: 'manual',
      confirmed: false,
      sourceDigest: 'sha256:e52c',
    };
    expect(sourceAttachmentAgreement(site, oligo({ bindings: [binding] })).kind).toBe('agrees');
    expect(
      sourceAttachmentAgreement(site, oligo({ bindings: [{ ...binding, start: 518470 }] })).kind
    ).toBe('differs');
    expect(sourceAttachmentAgreement(site, oligo()).kind).toBe('none');
  });

  it('replaces a primer link in place and drops links to removed primers', () => {
    const current = { ...design(), savedPrimerLinks: [link, { ...link, primerId: 'gone' }] };
    const merged = mergeSavedPrimerLinks(current, [{ ...link, artifactRevision: 5 }]);
    expect(merged).toEqual([{ ...link, artifactRevision: 5 }]);
  });

  it('keeps the first link time when the same oligo is linked again', () => {
    const current = { ...design(), savedPrimerLinks: [link] };
    const relinked = { ...link, linkedAt: '2026-11-11T09:30:00.000Z' };
    expect(relinked.linkedAt).not.toBe(link.linkedAt);

    expect(mergeSavedPrimerLinks(current, [relinked])).toEqual([link]);
    expect(mergeSavedPrimerLinks(current, [{ ...relinked, oligoId: 'oligo-other' }])).toEqual([
      { ...relinked, oligoId: 'oligo-other' },
    ]);
    expect(
      mergeSavedPrimerLinks(current, [{ ...relinked, sequenceContentHash: 'hash:changed' }])
    ).toEqual([{ ...relinked, sequenceContentHash: 'hash:changed' }]);
  });
});
