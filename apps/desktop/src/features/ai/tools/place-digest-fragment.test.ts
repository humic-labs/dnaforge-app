import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  placeDigestFragmentOutputSchema,
  virtualDigestOutputSchema,
} from './design-output-schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useDesignStore } from '../../design/store';
import { projectAssemblySlots } from '../../design/slot-projection';
import type { DesignRegion } from '../../design/types';
import { execOpts, execTool, resetCanvasStore } from './test-helpers';
import { useCanvasStore } from '../../canvas/store';
import { useSequenceStore } from '../../sequence/store';
import { parseBiologyContent } from './parse-biology-file';
import {
  createPlaceDigestFragmentTool,
  MAX_DIGEST_DESIGN_PERSISTED_BASES,
  placeDigestFragmentSchema,
  resetPlaceDigestFragmentIdempotencyForTests,
  setPlaceDigestFragmentIdempotencyLimitForTests,
} from './place-digest-fragment';
import { createVirtualDigestTool, MAX_DIGEST_ENZYMES } from './virtual-digest';

const { mockPlatform, mockResolveSequenceDocumentById } = vi.hoisted(() => ({
  mockPlatform: { fs: { readTextFile: vi.fn(), stat: vi.fn() } },
  mockResolveSequenceDocumentById: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mockResolveSequenceDocumentById,
  resolveCanonicalSequenceDocumentById: mockResolveSequenceDocumentById,
}));

const BSMBI = {
  name: 'BsmBI',
  recognition_sequence: 'CGTCTC',
  recognition_sequence_length: 6,
  cut_position_top: 7,
  cut_position_bottom: 11,
  overhang_type: '5_prime',
  overhang_length: 4,
  enzyme_type: 'Type IIS',
  prototype: null,
  source_organism: null,
  methylation_site: null,
  methylation_sensitivity: null,
};
vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadAllEnzymes: vi.fn(async () => [BSMBI]) };
});

const folders: WorkspaceFolder[] = [{ name: 'lab', path: '/home/user/lab', addedAt: 1 }];
const SOURCE_DOCUMENT_ID = 'sequence-document-p-test';
const SOURCE_PATH = '/home/user/lab/p.gb';
const OUTSIDE_DOCUMENT_ID = 'sequence-document-open-only';
const FILLER = 'AAAACCCCTTTTGGGGAAAACCCCTTTTGGGG';
const SOURCE = FILLER + 'CGTCTCAAAAAAAAAAAA' + FILLER + 'GAGACGTTTTTTTTTTTT' + FILLER;

function genBank(name: string, sequence: string, topology = 'circular'): string {
  const chunks: string[] = [];
  for (let i = 0; i < sequence.length; i += 60) {
    chunks.push(`${String(i + 1).padStart(9)} ${sequence.slice(i, i + 60)}`);
  }
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     ${topology} SYN 01-JAN-2026`,
    'FEATURES             Location/Qualifiers',
    'ORIGIN',
    ...chunks,
    '//',
    '',
  ].join('\n');
}

function annotatedGenBank(name: string, sequence: string, topology = 'circular'): string {
  return genBank(name, sequence, topology).replace(
    'FEATURES             Location/Qualifiers',
    [
      'FEATURES             Location/Qualifiers',
      `     gene            1..${sequence.length}`,
      '                     /label="whole-source-feature"',
    ].join('\n')
  );
}

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function resetStore() {
  resetPlaceDigestFragmentIdempotencyForTests();
  idempotencyCounter = 0;
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  resetCanvasStore();
  useSequenceStore.setState({ sequences: {} });
  mockResolveSequenceDocumentById.mockImplementation(async (documentId: string) => ({
    ref: { kind: 'catalog-sequence', entityId: documentId },
    documentId,
    sourcePath: documentId === SOURCE_DOCUMENT_ID ? SOURCE_PATH : '/home/user/open-only.gb',
  }));
}

const place = () => createPlaceDigestFragmentTool(folders);
const designOf = (id: string) => useDesignStore.getState().designs[id];
let idempotencyCounter = 0;

async function execPlace<T = unknown>(
  args: Record<string, unknown>,
  idempotencyKey = `place-test-${++idempotencyCounter}`
): Promise<T> {
  return execTool<T>(place(), { idempotencyKey, ...args });
}

type Result = {
  status: string;
  code?: string;
  error?: string;
  remedy?: string;
  slots?: Array<{
    slotIndex: number;
    regionId: string;
    isEmpty: boolean;
    occupantFingerprint: string;
  }>;
  slotsBefore?: unknown[];
  replaced?: { label: string } | null;
  movedSpacers?: Array<{ spacerId: string; wasBetween: string; nowBetween: string }>;
  actualSlotFingerprint?: string;
  availableFragmentIds?: string[];
  placedRegionId?: string;
  existingRegionId?: string;
  idempotentReplay?: boolean;
  adoptedGoldenGateEnzyme?: string | null;
  gaps?: Array<{ spacer: { sequence: string } | null }>;
  currentVersion?: number;
  revalidationRequired?: boolean;
};

async function digestIds(topology = 'circular', source = SOURCE) {
  mockPlatform.fs.stat.mockResolvedValue({ size: 999 } as never);
  mockPlatform.fs.readTextFile.mockResolvedValue(genBank('pTest', source, topology));
  const digest = await execDesignContract<{
    digestSnapshotId: string;
    fragments: Array<{ fragmentCandidateId: string; ggType: string }>;
  }>(virtualDigestOutputSchema, createVirtualDigestTool(folders), {
    documentId: SOURCE_DOCUMENT_ID,
    enzymes: ['BsmBI'],
  });
  const insert = digest.fragments.find((f) => f.ggType === 'insert') ?? digest.fragments[0];
  return {
    digestSnapshotId: digest.digestSnapshotId,
    fragmentCandidateId: insert.fragmentCandidateId,
  };
}

function designWithEmptySlot(): string {
  const store = useDesignStore.getState();
  const id = store.createDesign('Target', 'circular', 'gibson');
  store.addRegion(id, region('filled', 'AAATTTGGGCCC'));
  store.addRegion(id, region('second', 'TTTTGGGG'));
  const slots = projectAssemblySlots(designOf(id));
  store.clearRegion(id, slots[1].regionId);
  return id;
}

describe('place_digest_fragment — you cannot destroy what you have not looked at', () => {
  it('bounds the enzyme list at the schema boundary', () => {
    const parsed = placeDigestFragmentSchema.safeParse({
      designId: 'design',
      documentId: 'source-document',
      enzymes: Array.from({ length: MAX_DIGEST_ENZYMES + 1 }, (_, index) => `E${index}`),
      digestSnapshotId: 'snapshot',
      fragmentCandidateId: 'fragment',
      idempotencyKey: 'key',
      mode: 'replace',
      targetRegionId: 'region',
      expectedSlotFingerprint: 'fingerprint',
    });

    expect(parsed.success).toBe(false);
  });

  it('honors a canceled MCP call before reading or mutating a design', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execTool(
        place(),
        {
          designId: 'design',
          documentId: 'source-document',
          enzymes: ['BsmBI'],
          digestSnapshotId: 'snapshot',
          fragmentCandidateId: 'fragment',
          idempotencyKey: 'canceled',
          mode: 'replace',
          targetRegionId: 'region',
          expectedSlotFingerprint: 'fingerprint',
        },
        { ...execOpts, abortSignal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(useDesignStore.getState().designs).toEqual({});
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('refuses when the slot changed since the agent read it', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const stale = projectAssemblySlots(designOf(designId))[0];

    useDesignStore.getState().updateRegion(designId, stale.regionId, region('other', 'CCCCCCCC'));

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: stale.regionId,
      expectedSlotFingerprint: stale.occupantFingerprint,
    });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('SLOT_CHANGED');
    expect(result.actualSlotFingerprint).toBeDefined();
    expect(result.remedy).toMatch(/re-read/i);
    expect(result.slots).toBeDefined();
  });

  it('refuses fill_empty on an OCCUPIED slot and points at replace', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const occupied = projectAssemblySlots(designOf(designId))[0];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: occupied.regionId,
      expectedSlotFingerprint: occupied.occupantFingerprint,
    });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('SLOT_OCCUPIED');
    expect(result.remedy).toMatch(/replace/);
  });

  it('refuses replace on an ALREADY-EMPTY slot', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    });
    expect(result.code).toBe('SLOT_ALREADY_EMPTY');
  });

  it('fills an empty slot IN PLACE, keeping its position and id', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    const after = designOf(designId);
    expect(after.regions).toHaveLength(2);
    expect(after.regions[1].id).toBe(empty.regionId);
    expect(after.regions[1].isPlaceholder).toBeFalsy();
    expect(after.regions[1].sourceType).toBe('rd');
  });

  it('makes a sequential retry a noop instead of placing a duplicate', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];
    const args = {
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    };

    const first = await execPlace<Result>(args, 'same-placement');
    const versionAfterFirst = designOf(designId).version;
    const retry = await execPlace<Result>(args, 'same-placement');

    expect(first.status).toBe('applied');
    expect(retry.status).toBe('noop');
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.existingRegionId).toBe(first.placedRegionId);
    expect(designOf(designId).version).toBe(versionAfterFirst);
    expect(designOf(designId).regions).toHaveLength(2);
  });

  it('does not report a stale idempotency replay after the placed part was replaced', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];
    const args = {
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    };

    const first = await execPlace<Result>(args, 'placement-that-moves-on');
    expect(first.status).toBe('applied');
    useDesignStore
      .getState()
      .updateRegion(designId, first.placedRegionId!, region('replacement', 'CCCCCCCC'));

    const retry = await execPlace<Result>(args, 'placement-that-moves-on');

    expect(retry.status).toBe('rejected');
    expect(retry.code).toBe('IDEMPOTENCY_TARGET_CHANGED');
    expect(retry.existingRegionId).toBe(first.placedRegionId);
  });

  it('keeps a changed-target idempotency key burned across repeated retries', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const anchor = projectAssemblySlots(designOf(designId))[0];
    const args = {
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: anchor.regionId,
      expectedSlotFingerprint: anchor.occupantFingerprint,
    };

    const first = await execPlace<Result>(args, 'placement-key-must-stay-burned');
    expect(first.status).toBe('applied');
    useDesignStore.getState().removeRegion(designId, first.placedRegionId!);
    const versionAfterRemoval = designOf(designId).version;

    const firstRetry = await execPlace<Result>(args, 'placement-key-must-stay-burned');
    const secondRetry = await execPlace<Result>(args, 'placement-key-must-stay-burned');

    expect(firstRetry.code).toBe('IDEMPOTENCY_TARGET_CHANGED');
    expect(secondRetry.code).toBe('IDEMPOTENCY_TARGET_CHANGED');
    expect(designOf(designId).version).toBe(versionAfterRemoval);
    expect(
      designOf(designId).regions.filter(
        (candidate) => candidate.sourceSequenceId === SOURCE_DOCUMENT_ID
      )
    ).toHaveLength(0);
  });

  it('keeps evicted completed keys burned without retaining their full replay result', async () => {
    setPlaceDigestFragmentIdempotencyLimitForTests(1);
    const firstDesignId = designWithEmptySlot();
    const secondDesignId = designWithEmptySlot();
    const ids = await digestIds();
    const firstAnchor = projectAssemblySlots(designOf(firstDesignId))[0];
    const secondAnchor = projectAssemblySlots(designOf(secondDesignId))[0];
    const firstArgs = {
      designId: firstDesignId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: firstAnchor.regionId,
      expectedSlotFingerprint: firstAnchor.occupantFingerprint,
    };

    expect(await execPlace<Result>(firstArgs, 'eventually-evicted-key')).toMatchObject({
      status: 'applied',
    });
    expect(
      await execPlace<Result>(
        {
          ...firstArgs,
          designId: secondDesignId,
          targetRegionId: secondAnchor.regionId,
          expectedSlotFingerprint: secondAnchor.occupantFingerprint,
        },
        'newer-key'
      )
    ).toMatchObject({ status: 'applied' });
    const versionBeforeRetry = designOf(firstDesignId).version;

    const retry = await execPlace<Result>(firstArgs, 'eventually-evicted-key');

    expect(retry.code).toBe('IDEMPOTENCY_REPLAY_EXPIRED');
    expect(designOf(firstDesignId).version).toBe(versionBeforeRetry);
    expect(
      designOf(firstDesignId).regions.filter(
        (candidate) => candidate.sourceSequenceId === SOURCE_DOCUMENT_ID
      )
    ).toHaveLength(1);
  });

  it('refuses an idempotent replay after another design edit instead of pairing stale maps with a current version', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];
    const args = {
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    };

    const first = await execPlace<Result>(args, 'placement-before-spacer-edit');
    expect(first.status).toBe('applied');
    useDesignStore.getState().addSpacer(designId, 0, 'AACCGG', 'new linker');

    const retry = await execPlace<Result>(args, 'placement-before-spacer-edit');

    expect(retry.status).toBe('rejected');
    expect(retry.code).toBe('IDEMPOTENCY_DESIGN_CHANGED');
    expect(retry.currentVersion).toBe(designOf(designId).version);
    expect(retry.gaps?.[0]?.spacer?.sequence).toBe('AACCGG');
    expect(retry.revalidationRequired).toBe(true);
  });

  it('refuses an idempotency key reused for a different intent', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];
    const args = {
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    };

    await execPlace<Result>(args, 'collision-key');
    const collision = await execPlace<Result>(
      { ...args, fragmentCandidateId: 'different-fragment' },
      'collision-key'
    );

    expect(collision.status).toBe('rejected');
    expect(collision.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses when the design changes during asynchronous source resolution', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const slot = projectAssemblySlots(designOf(designId))[0];
    let releaseRead!: (content: string) => void;
    mockPlatform.fs.readTextFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        })
    );

    const pending = execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: slot.regionId,
      expectedSlotFingerprint: slot.occupantFingerprint,
    });
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));

    useDesignStore
      .getState()
      .updateRegion(designId, slot.regionId, region('human-edit', 'CCCCCCCC'));
    releaseRead(genBank('pTest', SOURCE));

    const result = await pending;
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('stale-design-version');
    expect(designOf(designId).regions[0].sourceSequenceName).toBe('human-edit');
  });

  it('a replace writes the NEW fragment RD provenance over the old', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Merge', 'circular', 'gibson');
    store.addRegion(designId, {
      ...region('old-rd', 'AAAACCCCGGGG'),
      sourceType: 'rd',
      ggType: 'backbone',
      rdSourceEnzyme: 'BsaI',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
    } as Omit<DesignRegion, 'id'>);
    store.addRegion(designId, region('other', 'TTTTGGGG'));

    const ids = await digestIds();
    const slot = projectAssemblySlots(designOf(designId))[0];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: slot.regionId,
      expectedSlotFingerprint: slot.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    const replacedRegion = designOf(designId).regions[0];
    expect(replacedRegion.rdSourceEnzyme).not.toBe('BsaI');
    expect(replacedRegion.rdOverhangs).not.toEqual({ upstream: 'AATG', downstream: 'GCTT' });
    expect(replacedRegion.ggType).not.toBe('backbone');
    expect(result.replaced?.label).toBe('old-rd');
  });

  it('anchors insertion to a slot, so a reorder cannot misplace it', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const anchor = projectAssemblySlots(designOf(designId))[0];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: anchor.regionId,
      expectedSlotFingerprint: anchor.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    const after = designOf(designId);
    expect(after.regions).toHaveLength(3);
    expect(after.regions[0].id).toBe(anchor.regionId);
    expect(after.regions[1].sourceType).toBe('rd');
  });

  it('keeps every placed fragment self-contained with its source context', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const firstAnchor = projectAssemblySlots(designOf(designId))[0];

    const first = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: firstAnchor.regionId,
      expectedSlotFingerprint: firstAnchor.occupantFingerprint,
    });
    expect(first.status).toBe('applied');

    const secondAnchor = projectAssemblySlots(designOf(designId)).find(
      (slot) => slot.regionId === first.placedRegionId
    )!;
    const second = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: secondAnchor.regionId,
      expectedSlotFingerprint: secondAnchor.occupantFingerprint,
    });
    expect(second.status).toBe('applied');

    const placed = designOf(designId).regions.filter(
      (candidate) => candidate.sourceSequenceId === SOURCE_DOCUMENT_ID
    );
    expect(placed).toHaveLength(2);
    expect(placed.every((candidate) => candidate.sourceSequence === SOURCE)).toBe(true);
    expect(placed.every((candidate) => candidate.sourceAnnotations?.length === 0)).toBe(true);
    expect(placed.every((candidate) => candidate.sourceLength === SOURCE.length)).toBe(true);
  });

  it('refuses repeated large placements from one source before persistence can grow unbounded', async () => {
    const largeSource =
      'A'.repeat(100_000) +
      'CGTCTCAAAAAAAAAAAA' +
      'C'.repeat(600_000) +
      'GAGACGTTTTTTTTTTTT' +
      'G'.repeat(100_000);
    const designId = designWithEmptySlot();
    const ids = await digestIds('circular', largeSource);
    const firstAnchor = projectAssemblySlots(designOf(designId))[0];

    const first = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: firstAnchor.regionId,
      expectedSlotFingerprint: firstAnchor.occupantFingerprint,
    });
    expect(first.status).toBe('applied');
    const secondAnchor = projectAssemblySlots(designOf(designId)).find(
      (slot) => slot.regionId === first.placedRegionId
    )!;

    const second = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: secondAnchor.regionId,
      expectedSlotFingerprint: secondAnchor.occupantFingerprint,
    });

    expect(second.code).toBe('DESIGN_SOURCE_BUDGET_EXCEEDED');
    expect(
      designOf(designId).regions.filter(
        (candidate) => candidate.sourceSequenceId === SOURCE_DOCUMENT_ID
      )
    ).toHaveLength(1);
  });

  it('refuses a new embedded source before the design can exceed its persisted-base budget', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId)).find((slot) => slot.isEmpty)!;
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          regions: state.designs[designId].regions.map((candidate, index) =>
            index === 0
              ? {
                  ...candidate,
                  sourceSequenceId: 'sequence-document-other',
                  sourceSequence: 'A'.repeat(MAX_DIGEST_DESIGN_PERSISTED_BASES - SOURCE.length + 1),
                }
              : candidate
          ),
        },
      },
    }));
    const currentEmpty = projectAssemblySlots(designOf(designId)).find(
      (slot) => slot.regionId === empty.regionId
    )!;

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: currentEmpty.regionId,
      expectedSlotFingerprint: currentEmpty.occupantFingerprint,
    });

    expect(result.code).toBe('DESIGN_SOURCE_BUDGET_EXCEEDED');
    expect(
      designOf(designId).regions.find((candidate) => candidate.id === empty.regionId)
    ).toMatchObject({ isPlaceholder: true });
  });

  it('counts placed region sequences in the persisted design budget', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          regions: state.designs[designId].regions.map((candidate, index) =>
            index === 0
              ? {
                  ...candidate,
                  sequence: 'A'.repeat(MAX_DIGEST_DESIGN_PERSISTED_BASES),
                }
              : candidate
          ),
        },
      },
    }));
    const empty = projectAssemblySlots(designOf(designId)).find((slot) => slot.isEmpty)!;

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    });

    expect(result.code).toBe('DESIGN_SOURCE_BUDGET_EXCEEDED');
    expect(
      designOf(designId).regions.find((candidate) => candidate.id === empty.regionId)
    ).toMatchObject({ isPlaceholder: true });
  });

  it('places from an already-open sequence document when no workspace is mounted', async () => {
    const outside = '/home/user/open-only.gb';
    const parsed = parseBiologyContent(genBank('openOnly', SOURCE), outside);
    useSequenceStore.setState({ sequences: { [OUTSIDE_DOCUMENT_ID]: parsed.sequence } });
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: OUTSIDE_DOCUMENT_ID,
      label: 'open-only.gb',
      sequenceDocument: { kind: 'catalog-sequence', entityId: OUTSIDE_DOCUMENT_ID },
    });
    const digest = await execDesignContract<{
      digestSnapshotId: string;
      fragments: Array<{ fragmentCandidateId: string; ggType: string }>;
    }>(virtualDigestOutputSchema, createVirtualDigestTool([]), {
      documentId: OUTSIDE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
    });
    const fragment = digest.fragments.find((candidate) => candidate.ggType === 'insert')!;
    const designId = designWithEmptySlot();
    const empty = projectAssemblySlots(designOf(designId)).find((slot) => slot.isEmpty)!;

    const result = await execDesignContract<Result>(
      placeDigestFragmentOutputSchema,
      createPlaceDigestFragmentTool([]),
      {
        designId,
        documentId: OUTSIDE_DOCUMENT_ID,
        enzymes: ['BsmBI'],
        digestSnapshotId: digest.digestSnapshotId,
        fragmentCandidateId: fragment.fragmentCandidateId,
        idempotencyKey: 'open-tab-no-workspace',
        mode: 'fill_empty',
        targetRegionId: empty.regionId,
        expectedSlotFingerprint: empty.occupantFingerprint,
      }
    );

    expect(result.status).toBe('applied');
    const placed = designOf(designId).regions.find(
      (region) => region.id === result.placedRegionId
    )!;
    expect(placed.sourceSequenceId).toBe(OUTSIDE_DOCUMENT_ID);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('reports a spacer whose junction identity changed, even at the same index', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Spacers', 'circular', 'gibson');
    store.addRegion(designId, region('a', 'AAAATTTT'));
    store.addRegion(designId, region('b', 'GGGGCCCC'));
    store.setJunctionSpacer(designId, 1, 'GCC');

    const ids = await digestIds();
    const last = projectAssemblySlots(designOf(designId))[1];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'insert_after',
      targetRegionId: last.regionId,
      expectedSlotFingerprint: last.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    expect(result.movedSpacers).toBeDefined();
    const after = designOf(designId);
    expect(after.spacers[0].anchor).toEqual({
      leftRegionId: after.regions[1].id,
      rightRegionId: after.regions[2].id,
    });
  });

  it('refuses a fragment the human drop path would also refuse', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('GG', 'circular', 'goldengate');
    store.addRegion(designId, {
      ...region('existing', 'AAAACCCCGGGG'),
      sourceType: 'rd',
      ggType: 'insert',
      rdSourceEnzyme: 'BsaI',
    } as Omit<DesignRegion, 'id'>);
    store.addRegion(designId, region('other', 'TTTTGGGG'));

    const ids = await digestIds();
    const slot = projectAssemblySlots(designOf(designId))[1];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: slot.regionId,
      expectedSlotFingerprint: slot.occupantFingerprint,
    });

    expect(result.status).toBe('rejected');
    expect(result.code).toBe('RD_ENZYME_MISMATCH');
    expect(result.remedy).toMatch(/same enzyme|remove the existing/i);
  });

  it('adopts the first digest fragment enzyme for a Golden Gate reaction', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('GG first RD', 'circular', 'goldengate');
    store.addRegion(designId, region('left', 'AAAACCCCGGGG'));
    store.addRegion(designId, region('right', 'TTTTGGGGCCCC'));
    expect(designOf(designId).goldenGateConfig?.enzyme).toBe('BsaI');

    const ids = await digestIds();
    const target = projectAssemblySlots(designOf(designId))[0];
    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: target.regionId,
      expectedSlotFingerprint: target.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    expect(result.adoptedGoldenGateEnzyme).toBe('BsmBI');
    expect(designOf(designId).goldenGateConfig?.enzyme).toBe('BsmBI');
  });

  it('validates replacement against the projected design without the outgoing RD part', async () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Replace sole RD', 'circular', 'goldengate');
    store.addRegion(designId, {
      ...region('old-bsa', 'AAAACCCCGGGG'),
      sourceType: 'rd',
      ggType: 'insert',
      rdSourceEnzyme: 'BsaI',
    } as Omit<DesignRegion, 'id'>);
    store.addRegion(designId, region('pcr', 'TTTTGGGGCCCC'));
    const ids = await digestIds();
    const target = projectAssemblySlots(designOf(designId))[0];

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'replace',
      targetRegionId: target.regionId,
      expectedSlotFingerprint: target.occupantFingerprint,
    });

    expect(result.status).toBe('applied');
    expect(designOf(designId).regions[0].rdSourceEnzyme).toBe('BsmBI');
    expect(designOf(designId).goldenGateConfig?.enzyme).toBe('BsmBI');
  });

  it('refuses when the source changed since the digest was read', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const empty = projectAssemblySlots(designOf(designId))[1];

    mockPlatform.fs.readTextFile.mockResolvedValue(genBank('pTest', SOURCE + 'AAAA'));

    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
    });

    expect(result.code).toBe('DIGEST_SNAPSHOT_STALE');
    expect(result.remedy).toMatch(/re-run virtual_digest/i);
  });

  it('returns a structured not-found for an unknown slot, with a way to recover', async () => {
    const designId = designWithEmptySlot();
    const ids = await digestIds();
    const result = await execPlace<Result>({
      designId,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      ...ids,
      mode: 'fill_empty',
      targetRegionId: 'nope',
      expectedSlotFingerprint: 'whatever',
    });
    expect(result.code).toBe('slot-not-found');
    expect(result.remedy).toMatch(/get_design/);
  });
});

describe('place_digest_fragment — the two digest tools agree about topology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('🟥 offers and resolves the SAME fragment set on a linear source', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 999 } as never);
    mockPlatform.fs.readTextFile.mockResolvedValue(genBank('pTest', SOURCE, 'linear'));

    const digest = await execDesignContract<{
      digestSnapshotId: string;
      fragmentCount: number;
      fragments: Array<{ fragmentCandidateId: string }>;
    }>(virtualDigestOutputSchema, createVirtualDigestTool(folders), {
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
    });

    const designId = designWithEmptySlot();
    const empty = projectAssemblySlots(designOf(designId)).find((slot) => slot.isEmpty)!;

    const notFound = await execPlace<Result>({
      designId,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      digestSnapshotId: digest.digestSnapshotId,
      fragmentCandidateId: 'frag:definitely-not-real',
    });

    expect(notFound.code).toBe('FRAGMENT_NOT_FOUND');
    expect(notFound.availableFragmentIds).toEqual(
      digest.fragments.map((fragment) => fragment.fragmentCandidateId)
    );
  });

  it('persists linear topology, annotations, and enzyme-labelled provenance', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 999 } as never);
    mockPlatform.fs.readTextFile.mockResolvedValue(
      annotatedGenBank('linearPart', SOURCE, 'linear')
    );
    const digest = await execDesignContract<{
      digestSnapshotId: string;
      fragments: Array<{ fragmentCandidateId: string; ggType: string }>;
    }>(virtualDigestOutputSchema, createVirtualDigestTool(folders), {
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
    });
    const insert = digest.fragments.find((fragment) => fragment.ggType === 'insert')!;
    const designId = designWithEmptySlot();
    const empty = projectAssemblySlots(designOf(designId)).find((slot) => slot.isEmpty)!;

    const result = await execPlace<Result>({
      designId,
      mode: 'fill_empty',
      targetRegionId: empty.regionId,
      expectedSlotFingerprint: empty.occupantFingerprint,
      documentId: SOURCE_DOCUMENT_ID,
      enzymes: ['BsmBI'],
      digestSnapshotId: digest.digestSnapshotId,
      fragmentCandidateId: insert.fragmentCandidateId,
    });

    expect(result.status).toBe('applied');
    const placed = designOf(designId).regions.find(
      (region) => region.id === result.placedRegionId
    )!;
    expect(placed.sourceIsCircular).toBe(false);
    expect(placed.sourceSequenceId).toBe(SOURCE_DOCUMENT_ID);
    expect(placed.sourceSequenceName).toMatch(/BsmBI fragment/);
    expect(placed.sourceAnnotations?.map((annotation) => annotation.name)).toContain(
      'whole-source-feature'
    );
    expect(placed.annotations.map((annotation) => annotation.name)).toContain(
      'whole-source-feature'
    );
  });
});
