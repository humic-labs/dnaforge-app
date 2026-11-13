import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readTextFile: vi.fn().mockResolvedValue(''),
      stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
      exists: vi.fn().mockResolvedValue(true),
    },
  },
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

vi.mock('../../../db/entity-references', () => ({
  getEntityReference: vi.fn(),
  updateEntityReference: vi.fn(),
}));
vi.mock('../../../db/workspace-catalog', () => ({
  getCatalogEntityForFilePath: vi.fn(),
}));
vi.mock('../../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: vi.fn(),
}));

import {
  resolveSelectionBases,
  resolveRawSelection,
  resolveSelectionInput,
  isSelectionError,
  sliceRangeBases,
} from './selection-tool-base';
import {
  getEntityReference,
  updateEntityReference,
  type DBEntityReference,
} from '../../../db/entity-references';
import { getCatalogEntityForFilePath } from '../../../db/workspace-catalog';
import { resolveSequenceDocumentById } from '../../sequence/sequence-document-repository';
import { useSequenceStore } from '../../sequence/store';

const DOCUMENT_ID = 'catalog-puc19';
const PATH = '/ws/pUC19.gb';
const BASES = 'AAATTTGGGCCC';

function seq(overrides: Partial<AnnotatedSequence> = {}): AnnotatedSequence {
  return {
    id: 'pUC19',
    name: 'pUC19',
    sequence: BASES,
    length: BASES.length,
    annotations: [],
    circular: false,
    ...overrides,
  };
}

function row(overrides: Partial<DBEntityReference> = {}): DBEntityReference {
  return {
    id: 'ref-1',
    entity_type: 'sequence_region',
    display_label: 'pUC19 4-6',
    locator: DOCUMENT_ID,
    deep_link_params: JSON.stringify({ start: 4, end: 6 }),
    data: null,
    source: 'user',
    status: 'created',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSequenceStore.getState().clearAll();
  vi.mocked(resolveSequenceDocumentById).mockResolvedValue({
    documentId: DOCUMENT_ID,
    sourcePath: PATH,
    ref: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
  });
});

describe('sliceRangeBases', () => {
  it('slices a forward inclusive 1-indexed range (4..6 → TTT)', () => {
    expect(sliceRangeBases(BASES, 4, 6, false)).toBe('TTT');
  });

  it('slices an origin-wrapping range (11..2 → CC + AA)', () => {
    expect(sliceRangeBases(BASES, 11, 2, true)).toBe('CCAA');
  });
});

describe('resolveSelectionBases', () => {
  it('resolves the wrap-aware slice from the resident store (zero fs)', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(row());

    const result = await resolveSelectionBases('ref-1');
    expect(isSelectionError(result)).toBe(false);
    if (isSelectionError(result)) return;
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(result.selectionBases).toBe('TTT');
    expect(result.range).toEqual({ start: 4, end: 6, wraps: false });
    expect(result.parentLength).toBe(12);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('honors wraps from deep_link_params', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq({ circular: true }));
    vi.mocked(getEntityReference).mockResolvedValue(
      row({ deep_link_params: JSON.stringify({ start: 11, end: 2, wraps: true }) })
    );

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error('unexpected error');
    expect(result.selectionBases).toBe('CCAA');
    expect(result.topology).toBe('circular');
  });

  it('returns STALE_SELECTION when the descriptor version drifts from the store', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(
      row({ data: JSON.stringify({ sourceVersion: 99 }) })
    );

    const result = await resolveSelectionBases('ref-1');
    expect(isSelectionError(result)).toBe(true);
    if (!isSelectionError(result)) return;
    expect(result.error).toBe('STALE_SELECTION');
  });

  it('does NOT flag stale when the descriptor version matches', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(
      row({ data: JSON.stringify({ sourceVersion: 1 }) })
    );

    const result = await resolveSelectionBases('ref-1');
    expect(isSelectionError(result)).toBe(false);
  });

  it('reads strand + translTable from the descriptor (never assumed)', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(
      row({
        data: JSON.stringify({
          measured: { start: 4, end: 6, strand: '-', readingFrames: [{ translTable: 11 }] },
        }),
      })
    );

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error('unexpected error');
    expect(result.strand).toBe('-');
    expect(result.translTable).toBe(11);
  });

  it('falls back to a filesystem read + parse when the sequence is not resident', async () => {
    const fastaPath = '/ws/pUC19.fasta';
    mockPlatform.fs.readTextFile.mockResolvedValueOnce(`>pUC19\n${BASES}\n`);
    vi.mocked(getEntityReference).mockResolvedValue(row());
    vi.mocked(resolveSequenceDocumentById).mockResolvedValueOnce({
      documentId: DOCUMENT_ID,
      sourcePath: fastaPath,
      ref: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
    });

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error('unexpected error');
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(fastaPath);
    expect(result.selectionBases).toBe('TTT');
  });

  it('repairs a historical physical-path locator to stable catalog identity', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(row({ locator: PATH }));
    vi.mocked(getCatalogEntityForFilePath).mockResolvedValue({
      id: DOCUMENT_ID,
    } as Awaited<ReturnType<typeof getCatalogEntityForFilePath>>);

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error('unexpected error');

    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(updateEntityReference).toHaveBeenCalledWith('ref-1', {
      locator: DOCUMENT_ID,
    });
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('returns REFERENCE_NOT_FOUND for an unknown id', async () => {
    vi.mocked(getEntityReference).mockResolvedValue(null);
    const result = await resolveSelectionBases('missing');
    expect(isSelectionError(result) && result.error).toBe('REFERENCE_NOT_FOUND');
  });

  it('returns NO_RANGE when neither deep_link_params nor descriptor carry a range', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(row({ deep_link_params: null, data: null }));
    const result = await resolveSelectionBases('ref-1');
    expect(isSelectionError(result) && result.error).toBe('NO_RANGE');
  });

  it('returns DISJOINT_SELECTION for a disjoint descriptor and never slices bases', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(
      row({
        deep_link_params: JSON.stringify({ start: 1, end: 3 }),
        data: JSON.stringify({
          measured: {
            start: 1,
            end: 3,
            disjoint: true,
            regionCount: 3,
            regions: [
              { codingDnaMapped: true, start: 1, end: 3, strand: '+' },
              { codingDnaMapped: true, start: 5, end: 7, strand: '+' },
              { codingDnaMapped: true, start: 9, end: 11, strand: '+' },
            ],
          },
        }),
      })
    );

    const result = await resolveSelectionBases('ref-1');
    expect(isSelectionError(result)).toBe(true);
    if (!isSelectionError(result)) return;
    expect(result.error).toBe('DISJOINT_SELECTION');
    expect(result.message).toMatch(/3 disjoint regions/);
    expect(result.message).toMatch(/1-3.*5-7.*9-11/s);
    expect(result.regions).toHaveLength(3);
    expect(result).not.toHaveProperty('selectionBases');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });
});

describe('resolved nucleic acid ', () => {
  it('takes the document molecule label for an app selection', async () => {
    useSequenceStore
      .getState()
      .setSequence(DOCUMENT_ID, seq({ sequence: 'AAAUUUGGGCCC', molecule: 'RNA' }));
    vi.mocked(getEntityReference).mockResolvedValue(row());

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error(result.message);
    expect(result.nucleicAcid).toBe('rna');
    expect(result.selectionBases).toBe('UUU');
  });

  it('is DNA for a document without an RNA molecule label', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(row());

    const result = await resolveSelectionBases('ref-1');
    if (isSelectionError(result)) throw new Error(result.message);
    expect(result.nucleicAcid).toBe('dna');
  });

  it('reads raw input bases: U without T is RNA, anything else DNA', () => {
    expect(resolveRawSelection({ sequence: 'AUGGCU' }).nucleicAcid).toBe('rna');
    expect(resolveRawSelection({ sequence: BASES }).nucleicAcid).toBe('dna');
    expect(resolveRawSelection({ sequence: 'ATGU' }).nucleicAcid).toBe('dna');
  });
});

describe('resolveRawSelection (pure, no app state)', () => {
  it('resolves the whole sequence when no sub-range is given', () => {
    const result = resolveRawSelection({ sequence: BASES });
    expect(result.refId).toBe('raw');
    expect(result.documentId).toBeNull();
    expect(result.parentSequence).toBe(BASES);
    expect(result.parentLength).toBe(12);
    expect(result.selectionBases).toBe(BASES);
    expect(result.range).toEqual({ start: 1, end: 12, wraps: false });
    expect(result.sourceVersion).toBeNull();
    expect(result.strand).toBe('unspecified');
    expect(result.translTable).toBeNull();
    expect(result.topology).toBe('linear');
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('slices a 1-indexed inclusive sub-range (4..6 → TTT)', () => {
    const result = resolveRawSelection({ sequence: BASES, start: 4, end: 6 });
    expect(result.selectionBases).toBe('TTT');
    expect(result.range).toEqual({ start: 4, end: 6, wraps: false });
  });

  it('passes strand / translTable / topology through verbatim', () => {
    const result = resolveRawSelection({
      sequence: BASES,
      strand: '-',
      translTable: 11,
      topology: 'circular',
    });
    expect(result.strand).toBe('-');
    expect(result.translTable).toBe(11);
    expect(result.topology).toBe('circular');
  });
});

describe('resolveSelectionInput (dispatcher)', () => {
  it('routes a {refId} input through resolveSelectionBases (real app-state read)', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(row());

    const result = await resolveSelectionInput({ refId: 'ref-1' });
    if (isSelectionError(result)) throw new Error('unexpected error');
    expect(result.refId).toBe('ref-1');
    expect(result.selectionBases).toBe('TTT');
  });

  it('still surfaces STALE_SELECTION through the {refId} arm on drift', async () => {
    useSequenceStore.getState().setSequence(DOCUMENT_ID, seq());
    vi.mocked(getEntityReference).mockResolvedValue(
      row({ data: JSON.stringify({ sourceVersion: 99 }) })
    );

    const result = await resolveSelectionInput({ refId: 'ref-1' });
    expect(isSelectionError(result) && result.error).toBe('STALE_SELECTION');
  });

  it('routes a {sequence} input through the pure resolveRawSelection (no app state)', async () => {
    const result = await resolveSelectionInput({ sequence: BASES, start: 4, end: 6 });
    if (isSelectionError(result)) throw new Error('unexpected error');
    expect(result.refId).toBe('raw');
    expect(result.selectionBases).toBe('TTT');
    expect(getEntityReference).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('returns INVALID_SELECTION_INPUT when NEITHER refId nor sequence is provided', async () => {
    const result = await resolveSelectionInput({});
    expect(isSelectionError(result) && result.error).toBe('INVALID_SELECTION_INPUT');
    expect(getEntityReference).not.toHaveBeenCalled();
  });

  it('returns INVALID_SELECTION_INPUT when BOTH refId and sequence are provided', async () => {
    const result = await resolveSelectionInput({ refId: 'ref-1', sequence: BASES });
    expect(isSelectionError(result) && result.error).toBe('INVALID_SELECTION_INPUT');
    expect(getEntityReference).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('treats an empty-string refId as "not provided" → INVALID_SELECTION_INPUT', async () => {
    const result = await resolveSelectionInput({ refId: '' });
    expect(isSelectionError(result) && result.error).toBe('INVALID_SELECTION_INPUT');
  });
});
