import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSequenceDocument } from '@waypoint/sequence-utils';
import { useSequenceStore } from './store';
import { saveEditedSequenceCopy } from './save-edited-sequence-copy';

const ports = vi.hoisted(() => ({
  picker: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  root: '',
  sourceId: '',
  findMember: vi.fn(),
  ensureIdentity: vi.fn(),
  bind: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    dialog: { save: ports.picker },
    fs: {
      exists: async (path: string) => existsSync(path),
      readTextFile: (path: string) => readFile(path, 'utf8'),
    },
  }),
}));
vi.mock('./sequence-document-client', () => ({ getNativeSequenceDocumentClient: () => undefined }));
vi.mock('../document-opening/public/compat', () => ({ openSequenceFile: ports.open }));
vi.mock('./create-empty-dna-sequence', () => ({
  createDnaSequencePackage: ports.create,
  normalizeSequencePackageName: (name: string) => name,
  SequenceCreationPendingError: class extends Error {},
}));
vi.mock('../../db/workspace-catalog', () => ({ findWorkspaceRootForPath: () => ports.root }));
vi.mock('../../db', () => ({ ensureSequenceIdentity: ports.ensureIdentity }));
vi.mock('./managed-sequence-repository', () => ({
  managedSequenceRepository: { findByMemberPath: ports.findMember },
}));
vi.mock('../sequence-clipboard/public/persist-primer-bindings', () => ({
  persistRichPastePrimerBindings: ports.bind,
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [{ path: ports.root }] }) },
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: {
        panel: {
          id: 'panel',
          tabs: [{ id: 'source-tab', type: 'sequence', entityId: ports.sourceId }],
        },
      },
      closeTab: ports.close,
    }),
  },
}));
vi.mock('./persist-sequence-document', () => ({
  SequencePersistenceError: class extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

async function fixture() {
  const sourcePath = join(ports.root, 'original.seq');
  const documentId = (ports.sourceId = crypto.randomUUID());
  const original = 'ACGTACGT';
  await writeFile(sourcePath, original);
  const parsed = decodeSequenceDocument(original, { filename: 'original.seq' }).sequence;
  const store = useSequenceStore.getState();
  store.setSequence(documentId, { ...parsed, id: documentId });
  store.replaceBases(documentId, 0, 1, 'T');
  store.addAnnotation(documentId, {
    name: 'mark',
    type: 'gene',
    start: 2,
    end: 4,
    direction: -1,
    color: '#345678',
    qualifiers: { note: ['saved annotation'] },
  });
  const capture = store.captureForSave(documentId)!;
  return {
    documentId,
    sourcePath,
    capture,
    original,
    save: () => saveEditedSequenceCopy({ documentId, sourcePath }, capture),
  };
}

describe('Save As for an edited loose sequence', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    ports.root = await mkdtemp(join(tmpdir(), 'edited-sequence-copy-'));
    ports.picker.mockResolvedValue(join(ports.root, 'Copy.v2'));
    ports.create.mockImplementation(async ({ destinationPath, name, content }) => {
      const packagePath = join(destinationPath, name);
      await mkdir(packagePath);
      const filePath = join(packagePath, name + '.gb');
      await writeFile(filePath, content);
      return { filePath };
    });
    ports.open.mockResolvedValue('target-tab');
  });
  afterEach(async () => {
    useSequenceStore.getState().clearAll();
    await rm(ports.root, { recursive: true, force: true });
  });
  it('opens the chosen package containing current bases and annotated edits and leaves source bytes intact', async () => {
    const f = await fixture();
    const result = await f.save();
    const filePath = join(ports.root, 'Copy.v2', 'Copy.v2.gb');
    expect(result).toMatchObject({
      ok: true,
      writtenRevision: f.capture.revision,
      copyDestination: { filePath, releasedSourceRevision: f.capture.revision + 1 },
    });
    const contents = decodeSequenceDocument(await readFile(filePath, 'utf8'), {
      filename: 'Copy.gb',
    }).sequence;
    expect(contents).toMatchObject({
      sequence: 'TCGTACGT',
      annotations: [
        {
          name: 'mark',
          start: 2,
          end: 4,
          direction: -1,
          color: '#345678',
          qualifiers: { note: ['saved annotation'] },
        },
      ],
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
    expect(ports.open).toHaveBeenCalledWith(expect.objectContaining({ filePath }));
    expect(ports.close).toHaveBeenCalledWith('panel', 'source-tab');
    expect(ports.picker).toHaveBeenCalledWith({
      purpose: 'edited-sequence-package',
      defaultPath: join(ports.root, 'original copy'),
    });
    expect(useSequenceStore.getState().isDirty(f.documentId)).toBe(false);
  });
  it('keeps cancelled edits and refuses to replace an existing destination', async () => {
    const f = await fixture();
    ports.picker.mockResolvedValueOnce(null);
    expect(await f.save()).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await writeFile(join(ports.root, 'Copy.v2'), 'already exists');
    expect(await f.save()).toMatchObject({ ok: false, wrote: false });
    expect(await readFile(join(ports.root, 'Copy.v2'), 'utf8')).toBe('already exists');
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
    expect(useSequenceStore.getState().getVersion(f.documentId)).toBe(f.capture.revision);
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
  });
  it('retains input arriving during publication and never acknowledges it as saved', async () => {
    const f = await fixture();
    ports.open.mockImplementation(async () => {
      useSequenceStore.getState().replaceBases(f.documentId, 1, 2, 'G');
      return 'target-tab';
    });
    expect(await f.save()).toMatchObject({ ok: false });
    expect(useSequenceStore.getState().sequences[f.documentId].sequence).toBe('TGGTACGT');
    expect(useSequenceStore.getState().isDirty(f.documentId)).toBe(true);
    expect(ports.close).not.toHaveBeenCalled();
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.original);
  });
  it('retries reopening a confirmed write without creating another copy', async () => {
    const f = await fixture();
    ports.open.mockResolvedValueOnce(null);
    expect(await f.save()).toMatchObject({ ok: false });
    expect(useSequenceStore.getState().isDirty(f.documentId)).toBe(true);
    expect(await f.save()).toMatchObject({ ok: true });
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.picker).toHaveBeenCalledTimes(1);
  });
});
