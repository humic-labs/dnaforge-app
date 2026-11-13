import { describe, expect, it, vi } from 'vitest';
import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  createSavedPrimerOligoCommands,
  type LinkAssemblyPrimerOligosInput,
  type SavedPrimerOligoDependencies,
} from '../../assembly/public/saved-primer-oligos';
import type { SavedOligoSnapshot } from '../../design/public/saved-primer-links';
import type { DesignPrimer, SequenceDesign } from '../../design/public/types';
import { saveDesignPrimersOutputSchema } from './scientific-authoring-output-schemas';
import { createSaveDesignPrimersTool, saveDesignPrimersSchema } from './save-design-primers';

const FORWARD_BINDING = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';
const REVERSE_BINDING = 'AAACTCGAACTGATAGAGCAAATCCAGT';
const REVERSE_FOOTPRINT = 'ACTGGATTTGCTCTATCAGTTCGAGTTT';
const FORWARD_TAIL = 'agaggagaaatacta';
const REVERSE_TAIL = 'ttatttgatgcctgg';
const FORWARD_OLIGO = `${FORWARD_TAIL}${FORWARD_BINDING}`.toUpperCase();
const REVERSE_OLIGO = `${REVERSE_TAIL}${REVERSE_BINDING}`.toUpperCase();
const SOURCE_START = 518478;

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

function world(overrides: Partial<SavedPrimerOligoDependencies> = {}) {
  let design: SequenceDesign = {
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
        sourceStart: SOURCE_START,
        sourceEnd: SOURCE_START + 80,
        sourceLength: 4641652,
        sourceIsCircular: true,
        sequence: `${FORWARD_BINDING}${'G'.repeat(80 - 29 - 28)}${REVERSE_FOOTPRINT}`,
        annotations: [],
      },
    ],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: primer('p-f', 'forward', FORWARD_TAIL, FORWARD_BINDING.toLowerCase()),
        reverse: primer('p-r', 'reverse', REVERSE_TAIL, REVERSE_BINDING.toLowerCase()),
      },
    ],
  };
  const oligos = new Map<string, SavedOligoSnapshot>();
  const addOligo = (
    oligo: Partial<SavedOligoSnapshot> & { oligoId: string; bases: string }
  ): SavedOligoSnapshot => {
    const snapshot: SavedOligoSnapshot = {
      catalogNumber: `P${380 + oligos.size}`,
      name: `saved-${oligo.oligoId}`,
      sequenceContentHash: `hash:${oligo.bases.toUpperCase()}`,
      artifactRevision: 2,
      chemistry: null,
      bindingSequence: null,
      tmC: 58.9,
      tmConcentrationNm: 500,
      tmModelLabel: 'Default (SantaLucia)',
      bindings: [],
      ...oligo,
    };
    oligos.set(snapshot.oligoId, snapshot);
    return snapshot;
  };
  const commands = createSavedPrimerOligoCommands({
    getDesign: (designId) => (designId === design.id ? design : undefined),
    setSavedPrimerLinks: (_designId, links) => {
      if (JSON.stringify(design.savedPrimerLinks ?? []) === JSON.stringify(links)) return false;
      design = { ...design, savedPrimerLinks: links };
      return true;
    },
    resolveWorkspaceRoot: async () => '/project',
    describeTm: () => ({
      evaluates: 'binding-part',
      modelLabel: 'Default (SantaLucia)',
      primerConcNm: 250,
    }),
    findOligosByBases: async (bases) =>
      [...oligos.values()].filter((item) => item.bases.toUpperCase() === bases.toUpperCase()),
    readOligo: async (oligoId) => oligos.get(oligoId) ?? null,
    saveOligo: async (designPrimer) =>
      addOligo({
        oligoId: `new-${designPrimer.id}`,
        bases: designPrimer.sequence,
        bindingSequence: designPrimer.pbs.sequence,
        artifactRevision: 1,
      }),
    restoreBindingSplit: async (oligo, bindingLength) => {
      const restored = {
        ...oligo,
        artifactRevision: oligo.artifactRevision + 1,
        bindingSequence: oligo.bases.slice(oligo.bases.length - bindingLength),
      };
      oligos.set(oligo.oligoId, restored);
      return restored;
    },
    now: () => new Date('2026-11-10T12:00:00.000Z'),
    ...overrides,
  });
  const link = vi.fn((input: LinkAssemblyPrimerOligosInput) =>
    commands.linkAssemblyPrimerOligos(input)
  );
  const call = <T>(args: Record<string, unknown>) =>
    execDesignContract<T>(
      saveDesignPrimersOutputSchema,
      createSaveDesignPrimersTool(link) as ContractTool,
      args
    );
  return { oligos, addOligo, link, call, links: () => design.savedPrimerLinks };
}

type ContractTool = Parameters<typeof execDesignContract>[1];

interface SavedPrimer {
  primerId: string;
  status: string;
  savedOligo: Record<string, unknown> | null;
  candidateOligoIds: string[];
  sourceAttachment: Record<string, unknown>;
}
interface Saved {
  ok: true;
  changed: boolean;
  linked: unknown[];
  kept: string[];
  ambiguous: unknown[];
  unsaved: string[];
  bindingSplitRestored: unknown[];
  primers: SavedPrimer[];
}
interface Refused {
  ok: false;
  code: string;
  retriable: boolean;
  stateChanged: unknown;
  partialEffects: unknown[];
  details?: Record<string, unknown>;
}

describe('save_design_primers', () => {
  it('registers unsaved primers, links the identical saved oligo and reports each use', async () => {
    const { addOligo, call, link, links } = world();
    addOligo({ oligoId: 'oligo-r', bases: REVERSE_OLIGO, artifactRevision: 4 });

    const saved = await call<Saved>({
      designId: 'waypoint://design/design-1',
      expectedDesignVersion: 11,
    });

    expect(link).toHaveBeenCalledWith({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: true,
      restoreMissingBindingSplit: false,
    });
    expect(saved).toMatchObject({
      ok: true,
      changed: true,
      designId: 'design-1',
      designVersion: 11,
      linked: [
        { primerId: 'p-f', oligoId: 'new-p-f', via: 'saved-from-assembly' },
        { primerId: 'p-r', oligoId: 'oligo-r', via: 'matched-existing' },
      ],
      kept: [],
      ambiguous: [],
      unsaved: [],
      unresolved: [],
      bindingSplitRestored: [],
      failed: [],
      tm: { evaluates: 'binding-part', modelLabel: 'Default (SantaLucia)', primerConcNm: 250 },
    });
    expect(saved.primers).toEqual([
      {
        primerId: 'p-f',
        name: 'F1-fwd',
        partNumber: 1,
        direction: 'forward',
        sequence: `${FORWARD_TAIL}${FORWARD_BINDING.toLowerCase()}`,
        bindingSequence: FORWARD_BINDING.toLowerCase(),
        tailSequence: FORWARD_TAIL,
        tmC: 58.2,
        sourceSite: {
          documentId: 'doc-genome',
          name: 'E. coli K-12',
          coordinateSystem: 'zero_based_half_open',
          start: SOURCE_START,
          end: SOURCE_START + 29,
          strand: 1,
          wraps: false,
          sourceLength: 4641652,
          circular: true,
        },
        status: 'linked',
        savedOligo: {
          oligoId: 'new-p-f',
          catalogNumber: 'P381',
          name: 'saved-new-p-f',
          artifactRevision: 1,
          linkedArtifactRevision: 1,
          linkedAtDesignVersion: 11,
          via: 'saved-from-assembly',
          oligoBindingSplit: 'same',
          tmC: 58.9,
          tmConcentrationNm: 500,
          tmModelLabel: 'Default (SantaLucia)',
        },
        candidateOligoIds: [],
        sourceAttachment: { state: 'none' },
      },
      expect.objectContaining({
        primerId: 'p-r',
        direction: 'reverse',
        bindingSequence: REVERSE_BINDING.toLowerCase(),
        tailSequence: REVERSE_TAIL,
        sourceSite: expect.objectContaining({
          start: SOURCE_START + 52,
          end: SOURCE_START + 80,
          strand: -1,
        }),
        status: 'linked',
        savedOligo: expect.objectContaining({
          oligoId: 'oligo-r',
          artifactRevision: 4,
          linkedArtifactRevision: 4,
          via: 'matched-existing',
          oligoBindingSplit: 'missing',
        }),
      }),
    ]);
    expect(links()).toHaveLength(2);
  });

  it('changes nothing when repeated', async () => {
    const { call, oligos } = world();
    await call<Saved>({ designId: 'design-1', expectedDesignVersion: 11 });

    const again = await call<Saved>({ designId: 'design-1', expectedDesignVersion: 11 });

    expect(again).toMatchObject({ changed: false, linked: [], kept: ['p-f', 'p-r'] });
    expect(oligos.size).toBe(2);
  });

  it('links without registering when saveUnsaved is false', async () => {
    const { call, oligos, links } = world();

    const inspected = await call<Saved>({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: false,
    });

    expect(inspected).toMatchObject({ changed: false, unsaved: ['p-f', 'p-r'] });
    expect(inspected.primers.map((entry) => [entry.status, entry.savedOligo])).toEqual([
      ['unsaved', null],
      ['unsaved', null],
    ]);
    expect(oligos.size).toBe(0);
    expect(links()).toBeUndefined();
  });

  it('reports identical saved oligos as ambiguous until one is chosen', async () => {
    const { addOligo, call } = world();
    addOligo({ oligoId: 'oligo-a', bases: FORWARD_OLIGO });
    addOligo({ oligoId: 'oligo-b', bases: FORWARD_OLIGO });

    const held = await call<Saved>({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: false,
    });
    expect(held.ambiguous).toEqual([{ primerId: 'p-f', oligoIds: ['oligo-a', 'oligo-b'] }]);
    expect(held.primers[0]).toMatchObject({
      status: 'ambiguous',
      savedOligo: null,
      candidateOligoIds: ['oligo-a', 'oligo-b'],
    });

    const chosen = await call<Saved>({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: false,
      choices: [{ primerId: 'p-f', oligoId: 'oligo-b' }],
    });
    expect(chosen.linked).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-b', via: 'matched-existing' },
    ]);
    expect(chosen.primers[0]).toMatchObject({
      status: 'linked',
      savedOligo: { oligoId: 'oligo-b' },
    });
  });

  it('restores a missing binding split on request and reports the agreeing source attachment', async () => {
    const { addOligo, call } = world();
    addOligo({
      oligoId: 'oligo-f',
      bases: FORWARD_OLIGO,
      bindings: [
        {
          id: 'binding-f',
          documentId: 'doc-genome',
          start: SOURCE_START,
          end: SOURCE_START + 29,
          strand: 1,
          placement: 'manual',
          confirmed: false,
          sourceDigest: 'sha256:genome',
        },
      ],
    });

    const restored = await call<Saved>({
      designId: 'design-1',
      expectedDesignVersion: 11,
      saveUnsaved: false,
      restoreMissingBindingSplit: true,
    });

    expect(restored.bindingSplitRestored).toEqual([
      { primerId: 'p-f', oligoId: 'oligo-f', artifactRevision: 3 },
    ]);
    expect(restored.primers[0]).toMatchObject({
      savedOligo: { artifactRevision: 3, linkedArtifactRevision: 3, oligoBindingSplit: 'same' },
      sourceAttachment: {
        state: 'agrees',
        binding: {
          id: 'binding-f',
          placement: 'manual',
          confirmed: false,
          sourceDigest: 'sha256:genome',
        },
      },
    });
  });

  it.each([
    ['DESIGN_NOT_FOUND', false, { designId: 'missing', expectedDesignVersion: 11 }, {}],
    ['STALE_DESIGN_VERSION', true, { designId: 'design-1', expectedDesignVersion: 10 }, {}],
    [
      'PROJECT_UNAVAILABLE',
      false,
      { designId: 'design-1', expectedDesignVersion: 11 },
      { resolveWorkspaceRoot: async () => null },
    ],
    [
      'INVALID_CHOICE',
      false,
      {
        designId: 'design-1',
        expectedDesignVersion: 11,
        choices: [{ primerId: 'p-f', oligoId: 'absent' }],
      },
      {},
    ],
  ] satisfies Array<
    [string, boolean, Record<string, unknown>, Partial<SavedPrimerOligoDependencies>]
  >)('returns %s as an explicit refusal', async (code, retriable, args, overrides) => {
    const { call } = world(overrides);

    const refused = await call<Refused>(args);

    expect(refused).toMatchObject({
      ok: false,
      code,
      retriable,
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('reports oligos it already saved when the design cannot take the links', async () => {
    const { call } = world({
      setSavedPrimerLinks: () => {
        throw new Error('The design is being finalized.');
      },
    });

    const refused = await call<Refused>({ designId: 'design-1', expectedDesignVersion: 11 });

    expect(refused).toMatchObject({
      ok: false,
      code: 'DESIGN_BUSY',
      retriable: true,
      stateChanged: true,
    });
    expect(refused.partialEffects).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'oligo-saved' })])
    );
  });

  it('refuses a design without drafted primers', async () => {
    const { call } = world({
      getDesign: () =>
        ({
          ...DESIGN_DEFAULTS,
          id: 'design-1',
          name: 'TamB Gibson',
          version: 11,
          assemblyMethod: 'gibson',
          spacers: [],
          designPrimers: [],
          regions: [],
        }) satisfies SequenceDesign,
    });

    expect(await call<Refused>({ designId: 'design-1', expectedDesignVersion: 11 })).toMatchObject({
      ok: false,
      code: 'NO_PRIMERS',
      retriable: false,
      stateChanged: false,
    });
  });

  it('returns the current primer report with a refusal that carries one', async () => {
    const { call } = world();

    const refused = await call<Refused>({
      designId: 'design-1',
      expectedDesignVersion: 11,
      choices: [{ primerId: 'p-f', oligoId: 'absent' }],
    });

    expect(refused.details).toMatchObject({
      designId: 'design-1',
      designVersion: 11,
      primers: [{ primerId: 'p-f' }, { primerId: 'p-r' }],
    });
  });

  it('reports unknown effects when the command throws', async () => {
    const failed = await execDesignContract<Refused>(
      saveDesignPrimersOutputSchema,
      createSaveDesignPrimersTool(async () => {
        throw new Error('database closed');
      }) as ContractTool,
      { designId: 'design-1', expectedDesignVersion: 11 }
    );

    expect(failed).toMatchObject({
      ok: false,
      code: 'SAVE_DESIGN_PRIMERS_FAILED',
      error: 'database closed',
      stateChanged: 'unknown',
    });
  });

  it('accepts only the documented inputs', () => {
    expect(
      saveDesignPrimersSchema.safeParse({ designId: 'design-1', expectedDesignVersion: 0 }).success
    ).toBe(true);
    expect(saveDesignPrimersSchema.safeParse({ designId: 'design-1' }).success).toBe(false);
    expect(
      saveDesignPrimersSchema.safeParse({
        designId: 'design-1',
        expectedDesignVersion: 0,
        choices: [{ primerId: 'p-f', oligoId: 'oligo-a', note: 'x' }],
      }).success
    ).toBe(false);
  });
});
