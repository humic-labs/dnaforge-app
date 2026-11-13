import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ChatEntityReferenceIpcRow } from '../../shared/chat-turn-ipc';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { translateSequence, reverseComplement } from '@waypoint/sequence-utils';

const { native, mockDb, mockFs } = vi.hoisted(() => {
  const native = { db: null as Database.Database | null };
  const mockDb = {
    createEntityReference: vi.fn(async (row: ChatEntityReferenceIpcRow) =>
      createEntityReferenceInDb(native.db!, row)
    ),
    select: vi.fn(async (sql: string, params: unknown[] = []) =>
      native.db!.prepare(sql).all(...params)
    ),
  };
  const mockFs = {
    readTextFile: vi.fn().mockResolvedValue(''),
    stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
    exists: vi.fn().mockResolvedValue(true),
  };
  return { native, mockDb, mockFs };
});

vi.mock('../../main/ipc/database', () => ({ getDb: () => native.db }));
vi.mock('../../platform', () => ({
  platform: () => ({ db: mockDb, fs: mockFs }),
  initPlatform: vi.fn().mockResolvedValue({ db: mockDb, fs: mockFs }),
}));

import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { createEntityReferenceInDb } from '../../main/entity-reference-commands';
import { registerCatalogEntityInDb } from '../../main/catalog-entity-registration';
import { createEntityReference } from '../../db/entity-references';
import { buildSelectionDescriptor } from './selection-descriptor/build';
import { isSelectionDescriptor } from './selection-descriptor/types';
import {
  resolveSelectionBases,
  isSelectionError,
  type ResolvedSelection,
} from './tools/selection-tool-base';
import { createSelectionTranslateTool } from './tools/selection-translate';
import { createGetSelectionBasesTool } from './tools/selection-bases';
import { execTool } from './tools/test-helpers';
import { parseBiologyContent } from './tools/parse-biology-file';
import { useSequenceStore } from '../sequence/store';

const PUC19_PATH = resolve(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb');
const PUC19_CONTENT = readFileSync(PUC19_PATH, 'utf-8');
const NCBI_PUC19 = parseBiologyContent(PUC19_CONTENT, PUC19_PATH).sequence;
const PUC19: AnnotatedSequence = {
  ...NCBI_PUC19,
  sequence: reverseComplement(NCBI_PUC19.sequence),
  annotations: NCBI_PUC19.annotations.map((annotation) => ({
    ...annotation,
    start: NCBI_PUC19.length - annotation.end + 1,
    end: NCBI_PUC19.length - annotation.start + 1,
    direction: annotation.direction === -1 ? 1 : annotation.direction === 1 ? -1 : 0,
  })),
};
const BASES = PUC19.sequence;

const LACZ_START = 2218;
const LACZ_PROTEIN_HEAD = 'MTMITPSLHA';
const DOCUMENT_ID = 'sequence-document-puc19';

function slice1(start: number, end: number): string {
  return BASES.slice(start - 1, end);
}

function seedResident(documentId: string, seq: AnnotatedSequence): void {
  useSequenceStore.getState().setSequence(documentId, seq);
}

async function persistDescriptor(
  documentId: string,
  range: { start: number; end: number; wraps?: boolean }
): Promise<string> {
  const built = buildSelectionDescriptor({ kind: 'sequence_region', documentId, range });
  expect(isSelectionDescriptor(built), 'descriptor built for a real region').toBe(true);
  const ref = await createEntityReference({
    entityType: 'sequence_region',
    displayLabel: `pUC19 ${range.start}-${range.end}`,
    locator: documentId,
    deepLinkParams: range,
    data: built as unknown as Record<string, unknown>,
    source: 'user',
  });
  return ref.id;
}

async function resolveOk(refId: string): Promise<ResolvedSelection> {
  const resolved = await resolveSelectionBases(refId);
  if (isSelectionError(resolved)) {
    throw new Error(`unexpected resolver error: ${resolved.error} — ${resolved.message}`);
  }
  return resolved;
}

beforeEach(() => {
  vi.clearAllMocks();
  native.db = createTestDb();
  ensureSchema(native.db, ':memory:');
  for (const id of [DOCUMENT_ID, 'sequence-document-puc19-minus'])
    registerCatalogEntityInDb(native.db, {
      id,
      type: 'sequence',
      name: 'pUC19',
      locator: `entity://sequence/${id}`,
      storageType: 'database',
    });
  useSequenceStore.getState().clearAll();
});

afterEach(() => native.db?.close());

describe(' A8 — selection → descriptor → refId → bases round-trip (real pUC19)', () => {
  it('parses the NCBI fixture and presents its reverse lacZ CDS in forward orientation', () => {
    expect(BASES.length).toBeGreaterThan(2000);
    expect(PUC19.circular).toBe(true);
    expect(NCBI_PUC19.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'CDS', start: 146, end: 469, direction: -1 }),
      ])
    );
    const lacz = (PUC19.annotations ?? []).find(
      (a) => a.type.toUpperCase() === 'CDS' && a.start === LACZ_START
    );
    expect(lacz, 'lacZ CDS present at 2218 in reverse-complement view').toBeTruthy();
    expect(lacz!.direction).toBe(1);
  });

  it('plus strand: refId resolves the CDS-start slice and translate returns the file’s own protein prefix', async () => {
    seedResident(DOCUMENT_ID, PUC19);
    const end = LACZ_START + 29;
    const refId = await persistDescriptor(DOCUMENT_ID, { start: LACZ_START, end });

    const resolved = await resolveOk(refId);
    expect(resolved.range).toEqual({ start: LACZ_START, end, wraps: false });
    expect(resolved.strand).toBe('+');
    expect(resolved.selectionBases).toBe(slice1(LACZ_START, end));
    expect(resolved.selectionBases.slice(0, 3).toUpperCase()).toBe('ATG');
    expect(resolved.selectionBases).toHaveLength(30);

    const translateTool = createSelectionTranslateTool([]);
    const t = await execTool<any>(translateTool, { refId });
    expect(t.protein).toBe(LACZ_PROTEIN_HEAD);
    expect(t.strand).toBe('+');
    expect(t.startsWithMet).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/[ACGT]{6,}/);

    const basesTool = createGetSelectionBasesTool([]);
    const b = await execTool<any>(basesTool, { refId, start: LACZ_START, end });
    expect(b.bases).toBe(slice1(LACZ_START, end));
    expect(b.length).toBe(30);
  });

  it('minus strand: resolver reads strand − and translate reverse-complements before translating', async () => {
    const minusDocumentId = 'sequence-document-puc19-minus';
    const minusSeq: AnnotatedSequence = {
      ...PUC19,
      annotations: (PUC19.annotations ?? []).map((a) =>
        a.type.toUpperCase() === 'CDS' && a.start === LACZ_START ? { ...a, direction: -1 } : a
      ),
    };
    seedResident(minusDocumentId, minusSeq);

    const end = LACZ_START + 29;
    const refId = await persistDescriptor(minusDocumentId, { start: LACZ_START, end });

    const resolved = await resolveOk(refId);
    expect(resolved.strand).toBe('-');
    expect(resolved.selectionBases).toBe(slice1(LACZ_START, end));

    const translateTool = createSelectionTranslateTool([]);
    const t = await execTool<any>(translateTool, { refId });
    expect(t.strand).toBe('-');

    const expected = translateSequence(reverseComplement(slice1(LACZ_START, end)), 1, 0)
      .map((c) => c.aminoAcid)
      .join('');
    expect(t.protein).toBe(expected);
    expect(t.protein).not.toBe(LACZ_PROTEIN_HEAD);
  });

  it('origin-wrap: descriptor flags spansOrigin and get_selection_bases reconstructs the wrap slice', async () => {
    seedResident(DOCUMENT_ID, PUC19);
    const N = BASES.length;
    const range = { start: N - 6, end: 6, wraps: true };

    const built = buildSelectionDescriptor({
      kind: 'sequence_region',
      documentId: DOCUMENT_ID,
      range,
    });
    expect(isSelectionDescriptor(built)).toBe(true);
    if (isSelectionDescriptor(built) && built.kind === 'sequence_region') {
      expect(built.measured.boundaryFlags.spansOrigin).toBe(true);
      expect(built.measured.wraps).toBe(true);
    }

    const refId = await persistDescriptor(DOCUMENT_ID, range);
    const resolved = await resolveOk(refId);
    expect(resolved.topology).toBe('circular');
    expect(resolved.range.wraps).toBe(true);

    const expectedWrap = BASES.slice(N - 7) + BASES.slice(0, 6);
    expect(resolved.selectionBases).toBe(expectedWrap);

    const basesTool = createGetSelectionBasesTool([]);
    const b = await execTool<any>(basesTool, { refId, start: N - 6, end: 6, wraps: true });
    expect(b.bases).toBe(expectedWrap);
    expect(b.length).toBe(13);
    expect(b.wraps).toBe(true);
  });

  it('1 bp: a single-base selection resolves to exactly that base', async () => {
    seedResident(DOCUMENT_ID, PUC19);
    const pos = 650;
    const refId = await persistDescriptor(DOCUMENT_ID, { start: pos, end: pos });

    const resolved = await resolveOk(refId);
    expect(resolved.selectionBases).toBe(slice1(pos, pos));
    expect(resolved.selectionBases).toHaveLength(1);

    const basesTool = createGetSelectionBasesTool([]);
    const b = await execTool<any>(basesTool, { refId, start: pos, end: pos });
    expect(b.bases).toBe(BASES[pos - 1]);
    expect(b.length).toBe(1);
  });

  it('STALE: editing the sequence after capture makes the tool report STALE_SELECTION, never a wrong answer', async () => {
    seedResident(DOCUMENT_ID, PUC19);
    const end = LACZ_START + 29;
    const refId = await persistDescriptor(DOCUMENT_ID, { start: LACZ_START, end });

    seedResident(DOCUMENT_ID, PUC19);

    const resolved = await resolveSelectionBases(refId);
    expect(isSelectionError(resolved)).toBe(true);
    if (isSelectionError(resolved)) expect(resolved.error).toBe('STALE_SELECTION');

    const translateTool = createSelectionTranslateTool([]);
    const t = await execTool<any>(translateTool, { refId });
    expect(t.error).toBe('STALE_SELECTION');
    expect(t.protein).toBeUndefined();
  });

  it('one refId drives resolver + translate + raw-window off the SAME persisted row', async () => {
    seedResident(DOCUMENT_ID, PUC19);
    const end = LACZ_START + 29;
    const refId = await persistDescriptor(DOCUMENT_ID, { start: LACZ_START, end });

    const resolved = await resolveOk(refId);
    const translateTool = createSelectionTranslateTool([]);
    const basesTool = createGetSelectionBasesTool([]);
    const t = await execTool<any>(translateTool, { refId });
    const b = await execTool<any>(basesTool, { refId, start: LACZ_START, end });

    expect(native.db!.prepare('SELECT id FROM entity_references').all()).toEqual([{ id: refId }]);
    expect(b.bases).toBe(resolved.selectionBases);
    expect(t.proteinLengthAa).toBe(resolved.selectionBases.length / 3);
  });
});
