import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCustomGeneticCode, parseGenBankFull } from '@waypoint/sequence-utils';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';

const mocks = vi.hoisted(() => ({
  resolveSequenceDocumentById: vi.fn(),
  readAdmittedTextFile: vi.fn(),
  writeTextFileAtomic: vi.fn(),
  findByMemberPath: vi.fn(),
  updateMetadata: vi.fn(),
  gitRepoRoot: vi.fn(),
  gitCommitPaths: vi.fn(),
}));

vi.mock('./sequence-document-repository', () => ({
  resolveSequenceDocumentById: mocks.resolveSequenceDocumentById,
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      readAdmittedTextFile: mocks.readAdmittedTextFile,
      writeTextFileAtomic: mocks.writeTextFileAtomic,
    },
  }),
}));
vi.mock('../workspace/git', () => ({
  gitRepoRoot: mocks.gitRepoRoot,
  gitCommitPaths: mocks.gitCommitPaths,
}));
vi.mock('./managed-sequence-repository', () => ({
  managedSequenceRepository: {
    findByMemberPath: mocks.findByMemberPath,
    updateMetadata: mocks.updateMetadata,
  },
}));

import { setSequenceGeneticCodeOnDocument } from './set-sequence-genetic-code';
import { useSequenceStore } from './store';

const DOC = 'sequence-genetic-code-core';
const SOURCE = '/ws/sequences/chrMT.gb';
const FOLDERS = [{ path: '/ws' }] as never;

function cds(overrides: Partial<Annotation> = {}): Annotation {
  return { name: 'cox1', type: 'CDS', start: 1, end: 9, direction: 1, ...overrides };
}

function record(annotations: Annotation[] = []): AnnotatedSequence {
  return {
    id: DOC,
    name: 'chrMT',
    sequence: 'ATGTGAAAA',
    length: 9,
    annotations,
    circular: false,
  };
}

const CURATED = [
  'LOCUS       NC_001224              9 bp    DNA     circular PLN 03-APR-2023',
  'DEFINITION  Saccharomyces cerevisiae S288c mitochondrion.',
  'VERSION     NC_001224.1',
  'DBLINK      BioProject: PRJNA927338',
  'KEYWORDS    RefSeq.',
  'SOURCE      mitochondrion Saccharomyces cerevisiae S288C',
  '  ORGANISM  Saccharomyces cerevisiae S288C',
  'REFERENCE   1  (bases 1 to 9)',
  '  AUTHORS   Foury,F.',
  'FEATURES             Location/Qualifiers',
  '     CDS             1..9',
  '                     /transl_table=3',
  'ORIGIN',
  '        1 atgtgaaaa',
  '//',
  '',
].join('\n');

function resetStore(): void {
  useSequenceStore.setState({
    sequences: {},
    savedSequences: {},
    drafts: {},
    dirtyPaths: {},
    sequenceVersions: {},
    savedVersions: {},
  });
}

describe('setSequenceGeneticCodeOnDocument', () => {
  beforeEach(() => {
    resetStore();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: SOURCE });
    mocks.findByMemberPath.mockResolvedValue(null);
    mocks.readAdmittedTextFile.mockResolvedValue(CURATED);
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.gitRepoRoot.mockResolvedValue('/ws');
    mocks.gitCommitPaths.mockResolvedValue(undefined);
  });

  it('edits the one line and leaves the rest of the record byte-identical', async () => {
    useSequenceStore.getState().setSequence(DOC, record());

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome.ok).toBe(true);
    const written = mocks.writeTextFileAtomic.mock.calls[0][0].content as string;
    expect(parseGenBankFull(written).chosenGeneticCode).toBe(3);
    for (const line of CURATED.split('\n')) {
      if (line) expect(written).toContain(line);
    }
    expect(written.split('\n')).toHaveLength(CURATED.split('\n').length + 1);
  });

  it('reflects the write in memory without leaving the document dirty', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });
    expect(useSequenceStore.getState().sequences[DOC].chosenGeneticCode).toBe(3);
    expect(useSequenceStore.getState().savedSequences[DOC].chosenGeneticCode).toBe(3);
    expect(useSequenceStore.getState().isDirty(DOC)).toBe(false);
  });

  it('routes a managed package through its own crash-safe transaction', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    mocks.findByMemberPath.mockResolvedValue({ ref: { packageId: 'pkg', packageRoot: '/ws/p' } });
    mocks.updateMetadata.mockResolvedValue({});

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome.ok).toBe(true);
    expect(mocks.updateMetadata.mock.calls[0][2]).toEqual({ geneticCode: 3 });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses text with no LOCUS rather than writing a stray comment', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    mocks.readAdmittedTextFile.mockResolvedValue('>fasta\nACGT\n');

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: false, error: 'write_failed' });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('loads a document that is not open, rather than refusing', async () => {
    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 4,
      folders: FOLDERS,
    });

    expect(outcome.ok).toBe(true);
    expect(useSequenceStore.getState().getSequence(DOC)).toBeTruthy();
  });

  it('never edits a feature that declares its own code, and says which those are', async () => {
    useSequenceStore
      .getState()
      .setSequence(
        DOC,
        record([cds({ qualifiers: { transl_table: ['3'] } }), cds({ name: 'undeclared' })])
      );

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 2,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: true, featuresDeclaringTheirOwnCode: ['cox1'] });
    const saved = useSequenceStore.getState().sequences[DOC];
    expect(saved.annotations[0].qualifiers?.transl_table).toEqual(['3']);
    expect(saved.annotations[1].qualifiers).toBeUndefined();
  });

  it('clears the override when given null', async () => {
    useSequenceStore.getState().setSequence(DOC, { ...record(), chosenGeneticCode: 3 });

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: null,
      folders: FOLDERS,
    });

    expect(outcome.ok).toBe(true);
    const written = mocks.writeTextFileAtomic.mock.calls[0][0].content as string;
    expect(parseGenBankFull(written).chosenGeneticCode).toBeUndefined();
    expect(useSequenceStore.getState().sequences[DOC].chosenGeneticCode).toBeUndefined();
  });

  it("refuses rather than folding someone's unsaved bases into this write", async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 3 });
    useSequenceStore.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'GGG' });

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: false, error: 'unsaved_edits' });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('refuses a document outside the writable workspace', async () => {
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: '/elsewhere/x.gb' });
    useSequenceStore.getState().setSequence(DOC, record());

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: false, error: 'outside_workspace' });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });

  it('reports a document it cannot resolve', async () => {
    mocks.resolveSequenceDocumentById.mockImplementation(async () => {
      throw new Error('nope');
    });

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: 'missing',
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: false, error: 'document_not_found' });
  });

  it('surfaces a failed write instead of claiming success', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    mocks.writeTextFileAtomic.mockImplementation(async () => {
      throw new Error('disk full');
    });

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    expect(outcome).toMatchObject({ ok: false, error: 'write_failed' });
    expect(outcome.ok === false && outcome.message).toContain('disk full');
  });
});

describe('a loose .gb change is recorded in history under its own subject', () => {
  beforeEach(() => {
    resetStore();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: SOURCE });
    mocks.findByMemberPath.mockResolvedValue(null);
    mocks.readAdmittedTextFile.mockResolvedValue(CURATED);
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.gitRepoRoot.mockResolvedValue('/ws');
    mocks.gitCommitPaths.mockResolvedValue(undefined);
  });

  it('commits with a subject that names the genetic code', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    await setSequenceGeneticCodeOnDocument({ documentId: DOC, geneticCode: 3, folders: FOLDERS });

    const [, message, paths] = mocks.gitCommitPaths.mock.calls[0];
    expect(message).toContain('genetic code (3)');
    expect(paths).toEqual(['sequences/chrMT.gb']);
  });

  it('says the code was cleared rather than naming a number', async () => {
    useSequenceStore.getState().setSequence(DOC, { ...record(), chosenGeneticCode: 3 });
    await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: null,
      folders: FOLDERS,
    });
    expect(mocks.gitCommitPaths.mock.calls[0][1]).toContain('cleared');
  });

  it('still reports success when the file is written but the commit fails', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    mocks.gitCommitPaths.mockImplementation(async () => {
      throw new Error('index.lock held');
    });
    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });
    expect(outcome.ok).toBe(true);
    expect(mocks.writeTextFileAtomic).toHaveBeenCalled();
  });

  it('does not commit separately for a managed package, which commits itself', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    mocks.findByMemberPath.mockResolvedValue({ ref: { packageId: 'p', packageRoot: '/ws/p' } });
    mocks.updateMetadata.mockResolvedValue({});
    await setSequenceGeneticCodeOnDocument({ documentId: DOC, geneticCode: 3, folders: FOLDERS });
    expect(mocks.gitCommitPaths).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).toHaveBeenCalled();
  });
});

describe('open views are told the file changed', () => {
  beforeEach(() => {
    resetStore();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: SOURCE });
    mocks.findByMemberPath.mockResolvedValue(null);
    mocks.readAdmittedTextFile.mockResolvedValue(CURATED);
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.gitRepoRoot.mockResolvedValue('/ws');
    mocks.gitCommitPaths.mockResolvedValue(undefined);
  });

  it('fires the reconciled event so the Git History drawer refreshes', async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail?.path);
    window.addEventListener('waypoint:workspace-reconciled', listener);
    useSequenceStore.getState().setSequence(DOC, record());

    await setSequenceGeneticCodeOnDocument({ documentId: DOC, geneticCode: 3, folders: FOLDERS });

    window.removeEventListener('waypoint:workspace-reconciled', listener);
    expect(seen).toEqual([SOURCE]);
  });

  it('does not fire when the write was refused', async () => {
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener('waypoint:workspace-reconciled', listener);
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: '/elsewhere/x.gb' });
    useSequenceStore.getState().setSequence(DOC, record());

    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: 3,
      folders: FOLDERS,
    });

    window.removeEventListener('waypoint:workspace-reconciled', listener);
    expect(outcome.ok).toBe(false);
    expect(fired).toBe(0);
  });
});

describe('recording a custom genetic code', () => {
  function amber(revision = 1) {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    return built.definition;
  }

  beforeEach(() => {
    resetStore();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveSequenceDocumentById.mockResolvedValue({ sourcePath: SOURCE });
    mocks.findByMemberPath.mockResolvedValue(null);
    mocks.readAdmittedTextFile.mockResolvedValue(CURATED);
    mocks.writeTextFileAtomic.mockResolvedValue(undefined);
    mocks.gitRepoRoot.mockResolvedValue('/ws');
    mocks.gitCommitPaths.mockResolvedValue(undefined);
  });

  it('writes the whole definition into the file, and the file alone reads it back', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: amber(),
      folders: FOLDERS,
    });
    expect(outcome.ok).toBe(true);
    const written: string = mocks.writeTextFileAtomic.mock.calls[0][0].content;
    expect(parseGenBankFull(written).chosenGeneticCode).toEqual(amber());
  });

  it('names the custom code and its revision in the commit', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: amber(2),
      folders: FOLDERS,
    });
    expect(mocks.gitCommitPaths.mock.calls[0][1]).toContain(
      'genetic code (Amber suppression (pAzF at TAG), revision 2)'
    );
  });

  it('refuses a damaged definition before touching the file', async () => {
    useSequenceStore.getState().setSequence(DOC, record());
    const outcome = await setSequenceGeneticCodeOnDocument({
      documentId: DOC,
      geneticCode: { ...amber(), residues: [] },
      folders: FOLDERS,
    });
    expect(outcome).toMatchObject({ ok: false, error: 'invalid_genetic_code' });
    expect(mocks.writeTextFileAtomic).not.toHaveBeenCalled();
  });
});
