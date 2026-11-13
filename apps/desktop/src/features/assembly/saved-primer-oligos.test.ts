import { describe, expect, it } from 'vitest';
import type { DesignPrimer, SequenceDesign } from '../design/public/types';
import type { SavedOligoSnapshot, SavedPrimerLink } from '../design/public/saved-primer-links';
import { createSavedPrimerOligoCommands } from './saved-primer-oligos';

const FORWARD_BINDING = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';
const REVERSE_BINDING = 'AAACTCGAACTGATAGAGCAAATCCAGT';
const REVERSE_FOOTPRINT = 'ACTGGATTTGCTCTATCAGTTCGAGTTT';

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

function primer(id: string, direction: 'forward' | 'reverse', tail: string, binding: string) {
  return {
    id,
    name: direction === 'forward' ? 'F1-fwd' : 'F1-rev',
    sequence: `${tail}${binding}`,
    pbs: { start: 0, end: binding.length, sequence: binding },
    overhang: { length: tail.length, sequence: tail, tailLength: tail.length },
    direction,
    fragmentIndex: 0,
    junctionIndex: 0,
    tm: 58.2,
  } satisfies DesignPrimer;
}

function world({
  workspaceRoot = '/project',
  advancingClock = false,
  finalizing = false,
}: {
  workspaceRoot?: string | null;
  advancingClock?: boolean;
  finalizing?: boolean;
} = {}) {
  let readings = 0;
  const now = () =>
    new Date(Date.parse('2026-11-10T12:00:00.000Z') + (advancingClock ? ++readings * 1000 : 0));
  const designs = new Map<string, SequenceDesign>();
  designs.set('design-1', {
    ...DESIGN_DEFAULTS,
    id: 'design-1',
    name: 'TamB Gibson',
    version: 11,
    assemblyMethod: 'gibson',
    spacers: [],
    regions: [
      {
        id: 'insert',
        sourceSequenceId: 'doc-genome',
        sourceSequenceName: 'E. coli K-12',
        sourceStart: 518478,
        sourceEnd: 518478 + 80,
        sourceLength: 4641652,
        sourceIsCircular: true,
        sequence: `${FORWARD_BINDING}${'G'.repeat(80 - 29 - 28)}${REVERSE_FOOTPRINT}`,
        annotations: [],
      },
    ],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: primer('p-f', 'forward', 'agaggagaaatacta', FORWARD_BINDING.toLowerCase()),
        reverse: primer('p-r', 'reverse', 'ttatttgatgcctgg', REVERSE_BINDING.toLowerCase()),
      },
    ],
  });

  const oligos = new Map<string, SavedOligoSnapshot>();
  const calls = { saved: [] as string[], restored: [] as string[], writes: 0 };
  const addOligo = (
    overrides: Partial<SavedOligoSnapshot> & { oligoId: string; bases: string }
  ) => {
    const snapshot: SavedOligoSnapshot = {
      catalogNumber: `P${380 + oligos.size}`,
      name: `saved-${overrides.oligoId}`,
      sequenceContentHash: `hash:${overrides.bases.toUpperCase()}`,
      artifactRevision: 2,
      chemistry: null,
      bindingSequence: null,
      tmC: 58.9,
      tmConcentrationNm: 500,
      tmModelLabel: 'Default (SantaLucia)',
      bindings: [],
      ...overrides,
    };
    oligos.set(snapshot.oligoId, snapshot);
    return snapshot;
  };
  const commands = createSavedPrimerOligoCommands({
    getDesign: (designId) => designs.get(designId),
    setSavedPrimerLinks: (designId, links: SavedPrimerLink[]) => {
      if (finalizing) {
        throw new Error(
          `Assembly ${designId} is being finalized. Edit it after publication finishes.`
        );
      }
      const current = designs.get(designId)!;
      if (JSON.stringify(current.savedPrimerLinks ?? []) === JSON.stringify(links)) return false;
      designs.set(designId, { ...current, savedPrimerLinks: links });
      calls.writes += 1;
      return true;
    },
    resolveWorkspaceRoot: async () => workspaceRoot,
    describeTm: () => ({
      evaluates: 'binding-part',
      modelLabel: 'Default (SantaLucia)',
      primerConcNm: 250,
    }),
    findOligosByBases: async (bases) =>
      [...oligos.values()].filter((item) => item.bases.toUpperCase() === bases.toUpperCase()),
    readOligo: async (oligoId) => oligos.get(oligoId) ?? null,
    saveOligo: async (designPrimer) => {
      calls.saved.push(designPrimer.id);
      return addOligo({
        oligoId: `new-${designPrimer.id}`,
        bases: designPrimer.sequence,
        bindingSequence: designPrimer.pbs.sequence,
        artifactRevision: 1,
      });
    },
    restoreBindingSplit: async (oligo, bindingLength) => {
      calls.restored.push(oligo.oligoId);
      const restored = {
        ...oligo,
        artifactRevision: oligo.artifactRevision + 1,
        bindingSequence: oligo.bases.slice(oligo.bases.length - bindingLength),
      };
      oligos.set(oligo.oligoId, restored);
      return restored;
    },
    now,
  });
  return { designs, oligos, calls, addOligo, commands };
}

const FORWARD_OLIGO = `AGAGGAGAAATACTA${FORWARD_BINDING}`;
const REVERSE_OLIGO = `TTATTTGATGCCTGG${REVERSE_BINDING}`;

describe('linking assembly primers to saved oligos', () => {
  it('links existing oligos by exact bases and pins the revision it matched', async () => {
    const { designs, addOligo, commands, calls } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO, artifactRevision: 4 });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });

    const result = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      expectedDesignVersion: 11,
    });

    expect(result.status).toBe('completed');
    expect(result.linked).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-f', via: 'matched-existing' },
      { primerId: 'p-r', oligoId: 'oligo-r', via: 'matched-existing' },
    ]);
    expect(designs.get('design-1')!.savedPrimerLinks).toEqual([
      expect.objectContaining({
        primerId: 'p-f',
        oligoId: 'oligo-f',
        artifactRevision: 4,
        sequenceContentHash: `hash:${FORWARD_OLIGO}`,
        linkedAtDesignVersion: 11,
      }),
      expect.objectContaining({ primerId: 'p-r', oligoId: 'oligo-r', artifactRevision: 2 }),
    ]);
    expect(designs.get('design-1')!.version).toBe(11);
    expect(calls.saved).toEqual([]);
    expect(result.report!.primers.map((entry) => entry.status)).toEqual(['linked', 'linked']);
    expect(result.report!.primers[0]!.oligoBindingSplit).toBe('missing');
  });

  it('changes nothing when repeated', async () => {
    const { addOligo, commands, calls, oligos } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });
    await commands.linkAssemblyPrimerOligos({ designId: 'design-1', saveUnsaved: true });

    const again = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      saveUnsaved: true,
    });

    expect(again.changed).toBe(false);
    expect(again.linked).toEqual([]);
    expect(again.kept).toEqual(['p-f', 'p-r']);
    expect(calls.writes).toBe(1);
    expect(calls.saved).toEqual([]);
    expect(oligos.size).toBe(2);
  });

  it('leaves unsaved primers alone unless asked to save them', async () => {
    const { designs, commands, calls } = world();

    const inspected = await commands.linkAssemblyPrimerOligos({ designId: 'design-1' });
    expect(inspected.unsaved).toEqual(['p-f', 'p-r']);
    expect(designs.get('design-1')!.savedPrimerLinks).toBeUndefined();

    const saved = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      saveUnsaved: true,
    });
    expect(calls.saved).toEqual(['p-f', 'p-r']);
    expect(saved.linked.map((item) => item.via)).toEqual([
      'saved-from-assembly',
      'saved-from-assembly',
    ]);
    expect(saved.report!.primers.map((entry) => entry.oligoBindingSplit)).toEqual(['same', 'same']);
  });

  it('holds identical saved oligos for an explicit choice', async () => {
    const { designs, addOligo, commands } = world();
    addOligo({ oligoId: 'oligo-a', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-b', bases: FORWARD_OLIGO });

    const first = await commands.linkAssemblyPrimerOligos({ designId: 'design-1' });
    expect(first.ambiguous).toEqual([{ primerId: 'p-f', oligoIds: ['oligo-a', 'oligo-b'] }]);
    expect(designs.get('design-1')!.savedPrimerLinks).toBeUndefined();

    const chosen = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      choices: [{ primerId: 'p-f', oligoId: 'oligo-b' }],
    });
    expect(chosen.linked).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-b', via: 'matched-existing' },
    ]);

    const wrong = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      choices: [{ primerId: 'p-r', oligoId: 'oligo-a' }],
    });
    expect(wrong.refusal?.code).toBe('invalid-choice');
  });

  it('refuses a stale design version and a design that changes mid-way', async () => {
    const { designs, addOligo, commands } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    const stale = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      expectedDesignVersion: 10,
    });
    expect(stale.refusal?.code).toBe('stale-design-version');

    const racing = world();
    racing.addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    const pending = racing.commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      saveUnsaved: true,
    });
    racing.designs.set('design-1', { ...racing.designs.get('design-1')!, version: 12 });
    const raced = await pending;
    expect(raced.refusal?.code).toBe('stale-design-version');
    expect(raced.oligoWrites).toEqual([
      { primerId: 'p-r', oligoId: 'new-p-r', kind: 'oligo-saved' },
    ]);
    expect(racing.designs.get('design-1')!.savedPrimerLinks).toBeUndefined();
    expect(designs.get('design-1')!.savedPrimerLinks).toBeUndefined();
  });

  it('shows which side changed after an edit and keeps the earlier link visible', async () => {
    const { designs, oligos, addOligo, commands } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    await commands.linkAssemblyPrimerOligos({ designId: 'design-1' });

    const design = designs.get('design-1')!;
    const edited = `aa${design.designPrimers[0]!.forward.sequence}`;
    designs.set('design-1', {
      ...design,
      version: 12,
      designPrimers: [
        {
          ...design.designPrimers[0]!,
          forward: { ...design.designPrimers[0]!.forward, sequence: edited },
        },
      ],
    });
    const afterDraftEdit = await commands.inspectAssemblyPrimerOligos('design-1');
    expect(afterDraftEdit!.primers[0]!.status).toBe('draft-primer-changed');
    expect(afterDraftEdit!.primers[0]!.link?.oligoId).toBe('oligo-f');

    designs.set('design-1', design);
    oligos.set('oligo-f', {
      ...oligos.get('oligo-f')!,
      bases: 'ACGTACGTACGTACGTACGT',
      sequenceContentHash: 'hash:edited',
      artifactRevision: 3,
    });
    const afterOligoEdit = await commands.inspectAssemblyPrimerOligos('design-1');
    expect(afterOligoEdit!.primers[0]!.status).toBe('oligo-bases-changed');
    expect(afterOligoEdit!.primers[0]!.oligoRevisedSinceLink).toBe(true);
  });

  it('restores a lost binding split only on request and pins the new revision', async () => {
    const { designs, addOligo, commands, calls } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO, artifactRevision: 4 });
    await commands.linkAssemblyPrimerOligos({ designId: 'design-1' });
    expect(calls.restored).toEqual([]);

    const restored = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      restoreMissingBindingSplit: true,
    });
    expect(restored.bindingSplitRestored).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-f', artifactRevision: 5 },
    ]);
    expect(restored.kept).toEqual([]);
    expect(designs.get('design-1')!.savedPrimerLinks![0]!.artifactRevision).toBe(5);
    expect(restored.report!.primers[0]!.oligoBindingSplit).toBe('same');

    const again = await commands.linkAssemblyPrimerOligos({
      designId: 'design-1',
      restoreMissingBindingSplit: true,
    });
    expect(again.bindingSplitRestored).toEqual([]);
    expect(calls.restored).toEqual(['oligo-f']);
  });
});

describe('reconciling a design with its saved oligos', () => {
  it('links unambiguous matches and writes nothing to the registry', async () => {
    const { designs, addOligo, commands, calls } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO, artifactRevision: 4 });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });

    const result = await commands.reconcileAssemblyPrimerOligos('design-1');

    expect(result.refusal).toBeNull();
    expect(result.linked).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-f', via: 'matched-existing' },
      { primerId: 'p-r', oligoId: 'oligo-r', via: 'matched-existing' },
    ]);
    expect(result.report!.primers.map((entry) => entry.status)).toEqual(['linked', 'linked']);
    expect(designs.get('design-1')!.version).toBe(11);
    expect(calls.saved).toEqual([]);
    expect(calls.restored).toEqual([]);
    expect(calls.writes).toBe(1);
  });

  it('leaves a primer with several identical oligos for a choice', async () => {
    const { designs, addOligo, commands, calls } = world();
    addOligo({ oligoId: 'oligo-a', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-b', bases: FORWARD_OLIGO });

    const result = await commands.reconcileAssemblyPrimerOligos('design-1');

    expect(result.linked).toEqual([]);
    expect(result.report!.primers.map((entry) => entry.status)).toEqual(['ambiguous', 'unsaved']);
    expect(designs.get('design-1')!.savedPrimerLinks).toBeUndefined();
    expect(calls.saved).toEqual([]);
    expect(calls.writes).toBe(0);
  });

  it('changes nothing when the design is opened again', async () => {
    const { addOligo, commands, calls } = world();
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });
    await commands.reconcileAssemblyPrimerOligos('design-1');

    const again = await commands.reconcileAssemblyPrimerOligos('design-1');

    expect(again.linked).toEqual([]);
    expect(again.report!.primers.map((entry) => entry.status)).toEqual(['linked', 'linked']);
    expect(calls.writes).toBe(1);
  });

  it('reports a closed project with a readable report instead of failing', async () => {
    const { commands, calls } = world({ workspaceRoot: null });

    const result = await commands.reconcileAssemblyPrimerOligos('design-1');

    expect(result.refusal?.code).toBe('project-unavailable');
    expect(result.linked).toEqual([]);
    expect(result.report!.workspaceRoot).toBeNull();
    expect(result.report!.primers.map((entry) => entry.status)).toEqual(['unsaved', 'unsaved']);
    expect(calls.writes).toBe(0);
  });

  it('writes once when two panels open the same design at the same moment', async () => {
    const { designs, addOligo, commands, calls } = world({ advancingClock: true });
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });

    const [first, second] = await Promise.all([
      commands.reconcileAssemblyPrimerOligos('design-1'),
      commands.reconcileAssemblyPrimerOligos('design-1'),
    ]);

    expect(first.refusal).toBeNull();
    expect(second.refusal).toBeNull();
    expect(calls.writes).toBe(1);
    expect(designs.get('design-1')!.savedPrimerLinks).toHaveLength(2);
    expect(designs.get('design-1')!.savedPrimerLinks!.map((saved) => saved.oligoId)).toEqual([
      'oligo-f',
      'oligo-r',
    ]);
    expect(designs.get('design-1')!.version).toBe(11);
  });

  it('gives up quietly while the design is being finalized', async () => {
    const { designs, addOligo, commands } = world({ finalizing: true });
    addOligo({ oligoId: 'oligo-f', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO });
    const result = await commands.reconcileAssemblyPrimerOligos('design-1');

    expect(result.refusal?.code).toBe('design-busy');
    expect(result.refusal?.message).toContain('being finalized');
    expect(result.report!.primers.map((entry) => entry.status)).toEqual([
      'match-available',
      'match-available',
    ]);
    expect(designs.get('design-1')!.savedPrimerLinks).toBeUndefined();
  });

  it('returns no report for a design that is gone', async () => {
    const { commands } = world();

    const result = await commands.reconcileAssemblyPrimerOligos('missing-design');

    expect(result.refusal?.code).toBe('design-not-found');
    expect(result.report).toBeNull();
  });
});
