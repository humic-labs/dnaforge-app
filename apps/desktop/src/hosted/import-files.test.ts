// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSessionFile, WorkspaceSessionFileWrite } from '@waypoint/domain-services';
import { decodeSequenceDocument } from '@waypoint/sequence-utils';
import {
  parseSequencePackageDocument,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  createDefaultSequenceEntityMetadata,
} from '../db/sequence-package';

const mocks = vi.hoisted(() => ({
  state: {
    activeWorkspaceId: '11111111-1111-4111-8111-111111111111' as string | null,
    principal: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
    snapshot: {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      revisionId: null,
      revisionNumber: 0,
      files: [] as WorkspaceSessionFile[],
    },
  },
  commit: vi.fn(
    async (
      _writes: readonly WorkspaceSessionFileWrite[],
      _progress?: (sent: number, total: number) => void
    ) => undefined
  ),
  initialize: vi.fn(async () => undefined),
  selectWorkspace: vi.fn(async () => undefined),
}));
vi.mock('./controller', () => ({
  hostedWorkspaceSessionController: {
    getState: () => mocks.state,
    commit: mocks.commit,
    selectWorkspace: mocks.selectWorkspace,
  },
  initializeHostedWorkspaceSession: mocks.initialize,
}));
import { importHostedSequenceFiles } from './import-files';

const sourceBytes = readFileSync(
  new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const originalActor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function sequenceFile(name = 'pUC19.gbk') {
  return new File([sourceBytes], name, { type: 'biosequence/genbank' });
}
function existing(path: string): WorkspaceSessionFile {
  return {
    path,
    resourceId: 'existing-resource',
    contentRevision: 'sha256:existing',
    contentType: 'text/plain',
    sizeBytes: 1,
  };
}
function marker(writes: readonly WorkspaceSessionFileWrite[]) {
  const file = writes.find((write) => write.path.endsWith('/.forge/plasmid.json'));
  if (!file) throw new Error('Import omitted its package marker');
  return parseSequencePackageDocument(new TextDecoder().decode(file.bytes));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.activeWorkspaceId = workspaceId;
  mocks.state.principal = { id: originalActor };
  mocks.state.snapshot = { workspaceId, revisionId: null, revisionNumber: 0, files: [] };
});

describe('managed browser GenBank import', () => {
  it('uses the production format6 builder and atomically commits metadata with exact source bytes', async () => {
    const progress = vi.fn();
    const result = await importHostedSequenceFiles([sequenceFile()], progress);
    expect(mocks.commit).toHaveBeenCalledOnce();
    const [writes, onProgress] = mocks.commit.mock.calls[0];
    expect(onProgress).toBe(progress);
    expect(writes.map((write) => write.path)).toEqual([
      'sequences/pUC19/.forge/plasmid.json',
      'sequences/pUC19/pUC19.gb',
    ]);
    expect(writes[1].bytes).toEqual(new Uint8Array(sourceBytes));
    expect(writes[1].contentType).toBe('application/genbank');
    const document = marker(writes);
    const decoded = decodeSequenceDocument(sourceBytes.toString('utf8'), { filename: 'pUC19.gbk' });
    expect(document).toMatchObject({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
      name: 'pUC19',
      product: { file: 'pUC19.gb', topology: 'circular' },
      members: [],
    });
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(document.entity).toEqual({
      ...createDefaultSequenceEntityMetadata(),
      fields: { ...createDefaultSequenceEntityMetadata().fields, locus: decoded.sequence.name },
    });
    expect(document).not.toHaveProperty('assembly');
    expect(result).toEqual({
      workspaceId,
      paths: [`/hosted/${workspaceId}/sequences/pUC19/pUC19.gb`],
    });
  });

  it('keeps the source presentation name separate from the decoded LOCUS identity', async () => {
    await importHostedSequenceFiles([sequenceFile('private-lab-copy.gbff')]);
    const writes = mocks.commit.mock.calls[0][0];
    expect(marker(writes).name).toBe('private-lab-copy');
    expect(marker(writes).entity.fields.locus).toBe(
      decodeSequenceDocument(sourceBytes.toString('utf8'), { filename: 'source.gb' }).sequence.name
    );
    expect(writes[1].path).toBe('sequences/private-lab-copy/private-lab-copy.gb');
    expect(writes[1].bytes).toEqual(new Uint8Array(sourceBytes));
  });

  it('gives each new package its own portable identity and publishes the selected batch once', async () => {
    const result = await importHostedSequenceFiles([
      sequenceFile('one.gb'),
      sequenceFile('two.gb'),
    ]);
    expect(mocks.commit).toHaveBeenCalledOnce();
    const writes = mocks.commit.mock.calls[0][0];
    const documents = writes
      .filter((write) => write.path.endsWith('/.forge/plasmid.json'))
      .map((write) => parseSequencePackageDocument(new TextDecoder().decode(write.bytes)));
    expect(new Set(documents.map((document) => document.id)).size).toBe(2);
    expect(writes).toHaveLength(4);
    expect(result.paths).toEqual([
      `/hosted/${workspaceId}/sequences/one/one.gb`,
      `/hosted/${workspaceId}/sequences/two/two.gb`,
    ]);
  });

  it.each([
    'sequences/pUC19/.forge/plasmid.json',
    'sequences/PUC19/user-owned.txt',
    'sequences/pUC19',
    'sequences',
  ])('refuses to replace an existing project object %s', async (path) => {
    mocks.state.snapshot.files = [existing(path)];
    await expect(importHostedSequenceFiles([sequenceFile()])).rejects.toThrow(
      'replace an existing project object'
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('refuses selected packages that collide after removing source suffixes', async () => {
    await expect(
      importHostedSequenceFiles([sequenceFile('same.gb'), sequenceFile('SAME.gbff')])
    ).rejects.toThrow('same project path');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('does not rewrite or delete an existing loose-file compatibility entry', async () => {
    mocks.state.snapshot.files = [existing('sequences/pUC19.gbk')];
    await importHostedSequenceFiles([sequenceFile()]);
    expect(
      mocks.commit.mock.calls[0][0].some((write) => write.path === 'sequences/pUC19.gbk')
    ).toBe(false);
    expect(mocks.state.snapshot.files).toEqual([existing('sequences/pUC19.gbk')]);
  });

  it('preserves non-GenBank import paths, MIME labels and binary bytes', async () => {
    const bytes = new Uint8Array([0xff, 0, 1, 127]);
    const result = await importHostedSequenceFiles([
      new File([bytes], 'notes.bin', { type: 'application/octet-stream' }),
    ]);
    expect(mocks.commit.mock.calls[0][0]).toEqual([
      { path: 'files/notes.bin', bytes, contentType: 'application/octet-stream' },
    ]);
    expect(result.paths).toEqual([`/hosted/${workspaceId}/files/notes.bin`]);
  });

  it('stores a picked file whose browser type storage refuses as octet-stream', async () => {
    const reads = new Uint8Array([0x1f, 0x8b, 8, 0]);
    const notes = new TextEncoder().encode('ACGT\n');
    await importHostedSequenceFiles([
      new File([reads], 'reads.fastq.gz', { type: 'application/gzip' }),
      new File([notes], 'notes.txt', { type: 'text/plain' }),
    ]);
    expect(mocks.commit.mock.calls[0][0]).toEqual([
      { path: 'files/reads.fastq.gz', bytes: reads, contentType: 'application/octet-stream' },
      { path: 'files/notes.txt', bytes: notes, contentType: 'text/plain' },
    ]);
  });

  it('stores a PDF under a media type the project bucket accepts', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n');
    await importHostedSequenceFiles([new File([bytes], 'paper.pdf', { type: 'application/pdf' })]);
    expect(mocks.commit.mock.calls[0][0]).toEqual([
      { path: 'files/paper.pdf', bytes, contentType: 'application/octet-stream' },
    ]);
  });

  it('converts SnapGene DNA into a GenBank package that keeps the original bytes', async () => {
    const snapgene = readFileSync(
      new URL('../../../../test-fixtures/import-formats/pUC19.dna', import.meta.url)
    );
    const result = await importHostedSequenceFiles([
      new File([snapgene], 'pUC19.dna', { type: 'application/octet-stream' }),
    ]);
    const writes = mocks.commit.mock.calls[0][0];
    const document = marker(writes);
    const [evidence] = document.members;
    expect(writes.map((write) => write.path)).toEqual([
      'sequences/pUC19/.forge/plasmid.json',
      'sequences/pUC19/pUC19.gb',
      `sequences/pUC19/${evidence.path}`,
    ]);
    expect(evidence).toMatchObject({ role: 'evidence-input', path: 'contents/pUC19.dna' });
    expect(writes[2].bytes).toEqual(new Uint8Array(snapgene));
    expect(document.product).toMatchObject({ file: 'pUC19.gb', topology: 'circular' });
    const product = decodeSequenceDocument(new TextDecoder().decode(writes[1].bytes), {
      filename: 'pUC19.gb',
    });
    expect(product.format).toBe('genbank');
    expect(product.sequence.length).toBe(2686);
    expect(product.sequence.annotations.length).toBeGreaterThan(0);
    expect(result.paths).toEqual([`/hosted/${workspaceId}/sequences/pUC19/pUC19.gb`]);
  });

  it('converts nucleotide FASTA records into GenBank packages', async () => {
    const fasta = readFileSync(
      new URL('../../../../test-fixtures/indexed/pUC19/pUC19.fa', import.meta.url)
    );
    const twoRecords = new TextEncoder().encode('>first DNA\nACGTACGTAC\n>second DNA\nTTGGCCAA\n');
    const result = await importHostedSequenceFiles([
      new File([fasta], 'pUC19.fa'),
      new File([twoRecords], 'pair.fasta'),
    ]);
    const writes = mocks.commit.mock.calls[0][0];
    expect(writes.map((write) => write.path)).toEqual([
      'sequences/pUC19/.forge/plasmid.json',
      'sequences/pUC19/pUC19.gb',
      'sequences/first/.forge/plasmid.json',
      'sequences/first/first.gb',
      'sequences/second/.forge/plasmid.json',
      'sequences/second/second.gb',
    ]);
    const product = decodeSequenceDocument(new TextDecoder().decode(writes[1].bytes), {
      filename: 'pUC19.gb',
    });
    expect(product.sequence.sequence.toUpperCase()).toBe(
      fasta.toString('utf8').split('\n').slice(1).join('').toUpperCase()
    );
    expect(marker(writes).members).toEqual([]);
    expect(result.paths).toEqual([
      `/hosted/${workspaceId}/sequences/pUC19/pUC19.gb`,
      `/hosted/${workspaceId}/sequences/first/first.gb`,
      `/hosted/${workspaceId}/sequences/second/second.gb`,
    ]);
  });

  const msn2Protein = new URL(
    '../../../../test-fixtures/import-formats/S288C_YMR037C_MSN2_protein.faa',
    import.meta.url
  );

  it.skipIf(!existsSync(msn2Protein))(
    'keeps FASTA that cannot convert losslessly as the original file',
    async () => {
      const protein = readFileSync(msn2Protein);
      const gapped = new TextEncoder().encode('>gapped\nACGT--ACGT\n');
      const result = await importHostedSequenceFiles([
        new File([protein], 'MSN2.faa'),
        new File([gapped], 'gapped.fasta'),
      ]);
      expect(mocks.commit.mock.calls[0][0].map((write) => write.path)).toEqual([
        'files/MSN2.faa',
        'files/gapped.fasta',
      ]);
      expect(result.paths).toEqual([
        `/hosted/${workspaceId}/files/MSN2.faa`,
        `/hosted/${workspaceId}/files/gapped.fasta`,
      ]);
    }
  );

  it('leaves alignment query FASTA unconverted when the caller asks for source files', async () => {
    const reads = new TextEncoder().encode('>read DNA\nACGTACGTAC\n');
    await importHostedSequenceFiles([new File([reads], 'reads.fasta')], undefined, undefined, {
      convertSequences: false,
    });
    expect(mocks.commit.mock.calls[0][0].map((write) => write.path)).toEqual(['files/reads.fasta']);
  });

  it('rejects invalid UTF-8 without committing a partial marker or product', async () => {
    await expect(
      importHostedSequenceFiles([new File([new Uint8Array([0xff])], 'invalid.gb')])
    ).rejects.toThrow('not valid UTF-8');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('rejects multiple records explicitly rather than giving a multi-product source one package identity', async () => {
    await expect(
      importHostedSequenceFiles([new File([sourceBytes, sourceBytes], 'multi.gb')])
    ).rejects.toThrow('multiple records');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each(['project', 'account'])(
    'refuses a %s switch while browser file bytes are being read',
    async (kind) => {
      const file = sequenceFile();
      const read = file.arrayBuffer.bind(file);
      vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
        const bytes = await read();
        if (kind === 'project') mocks.state.activeWorkspaceId = 'other-project';
        else mocks.state.principal = { id: 'different-account' };
        return bytes;
      });
      await expect(importHostedSequenceFiles([file])).rejects.toThrow('changed while importing');
      expect(mocks.commit).not.toHaveBeenCalled();
    }
  );
});
