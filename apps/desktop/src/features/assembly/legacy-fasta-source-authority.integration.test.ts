import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBridge } from '../../platform/types';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  platform: vi.fn(),
  sender: null as (EventEmitter & { id: number }) | null,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = state.handlers.get(channel);
      if (!handler) throw new Error(`Missing native handler: ${channel}`);
      return handler({ sender: state.sender }, ...args);
    },
  },
  app: { getPath: () => '/tmp/dnaforge-test-app-data', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../platform', () => ({ platform: state.platform }));

import { createFileTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { registerDatabaseHandlers } from '../../main/ipc/database';
import { createClient } from '../../shared/ipc-contract';
import { dbContract } from '../../shared/ipc/db.contract';
import { buildFileDnaSequenceRef } from '../lims/public/dna-sequence';
import { createAddDesignRegionTool } from '../ai/public/tools/add-design-region';
import { execTool } from '../../test/ai/exec-tool';
import { useDesignStore } from '../design/public/store';
import { useSequenceStore } from '../sequence/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { getSequenceWithPath } from '../../db';
import {
  loadAllSourceSequencesFromDb,
  loadSourceSequenceForKey,
} from '../junction-workbench/public/SourceContextRegistry';
import { resolveAcceptedSourceIdentity } from './accepted-source-identity';
import {
  buildPrimerArtifact,
  primerLegacyProjectionFromArtifact,
  serializePrimerArtifact,
} from '../primers/public/primer-artifact';

let fixture: ReturnType<typeof createFileTestDb>;
let client: PlatformBridge['db'];
let root: string;
let path: string;
let designId: string;
let workspaceId: number;
const documentId = 'legacy-cached-fasta';
async function addRegion() {
  return execTool<{ regionId: string | null; error?: string }>(
    createAddDesignRegionTool([{ name: 'Project', path: root, addedAt: 1 }]),
    { designId, documentId, start: 1, end: 4 }
  );
}

beforeEach(async () => {
  fixture = createFileTestDb('legacy-fasta-canonical-source');
  mkdirSync(join(fixture.tmpDir, 'Project'));
  root = realpathSync(join(fixture.tmpDir, 'Project'));
  path = join(root, 'Legacy.faa');
  writeFileSync(path, '>Legacy\nMKTW\n');
  ensureSchema(fixture.db, fixture.dbPath);
  state.handlers.clear();
  state.sender = Object.assign(new EventEmitter(), { id: 366178 });
  registerDatabaseHandlers(() => fixture.db);
  client = {
    ...createClient(dbContract),
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> => {
      const handler = state.handlers.get('db:select');
      if (!handler) throw new Error('Missing native select handler');
      return (await handler({ sender: state.sender }, sql, params)) as T;
    },
  };
  state.platform.mockReturnValue({
    db: client,
    fs: {
      readTextFile: async (source: string) => readFileSync(source, 'utf8'),
      readFile: async (source: string) => new Uint8Array(readFileSync(source)),
      stat: async (source: string) => {
        const stat = statSync(source);
        return { size: stat.size, mtime: stat.mtimeMs };
      },
    },
  });
  const ownerId = await client.ensureWorkspaceOwner(root);
  workspaceId = ownerId;
  fixture.db
    .prepare(
      `INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
       VALUES(?,'sequence','Legacy',?,'file','active',?,1,1)`
    )
    .run(documentId, `file://${path}`, ownerId);
  await client.bindCatalogEntityFile({
    entityId: documentId,
    workspaceRoot: root,
    path,
    fileKind: 'fasta',
    objectUuid: 'legacy-cached-object',
  });
  fixture.db
    .prepare(
      "INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at) VALUES(10,?,?,'Legacy','faa',1)"
    )
    .run(ownerId, path);
  fixture.db
    .prepare(
      "INSERT INTO sequences(id,file_id,document_id,name,length,circular,sequence) VALUES(24,10,?,'Legacy',4,0,'MKTW')"
    )
    .run(documentId);
  useWorkspaceStore.setState({
    folders: [{ name: 'Project', path: root, addedAt: 1 }],
    activeWorkspaceFile: null,
  });
  useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  designId = useDesignStore.getState().createDesign('Derivative', 'circular', 'gibson');
  useSequenceStore.getState().setSequence(documentId, {
    id: documentId,
    name: 'Legacy',
    sequence: 'MKTW',
    length: 4,
    circular: false,
    annotations: [],
  });
});
afterEach(() => {
  state.sender?.removeAllListeners();
  useSequenceStore.getState().clearSequence(documentId);
  useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
  state.platform.mockReset();
  fixture.cleanup();
});

describe('cached historical FASTA cannot become a canonical scientific source', () => {
  it('already refuses normal primer target construction even when a numeric DNA index exists', async () => {
    await expect(
      buildFileDnaSequenceRef(path, { workspaceRoot: root, documentId })
    ).rejects.toThrow('FASTA_KIND_CLASSIFICATION_REQUIRED');
    expect(await getSequenceWithPath(24)).toMatchObject({
      document_id: documentId,
      sequence: 'MKTW',
    });
  });

  it('refuses normal assembly fragment authoring before accepting resident cached DNA state', async () => {
    const result = await addRegion();
    expect(result.regionId).toBeNull();
    expect(result.error).toContain('FASTA_KIND_CLASSIFICATION_REQUIRED');
    expect(useDesignStore.getState().designs[designId].regions).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('>Legacy\nMKTW\n');
  });

  it('refuses treating a cached numeric or stable-ID source as canonical pinned assembly context', async () => {
    await expect(loadSourceSequenceForKey(documentId)).rejects.toThrow(
      'FASTA_KIND_CLASSIFICATION_REQUIRED'
    );
    await expect(loadSourceSequenceForKey('seq_24')).rejects.toThrow(
      'FASTA_KIND_CLASSIFICATION_REQUIRED'
    );
    expect(await getSequenceWithPath(24)).toMatchObject({ sequence: 'MKTW' });
  });

  it('keeps an undeclared cached DNA row out of the bulk canonical source context', async () => {
    expect(await loadAllSourceSequencesFromDb()).toEqual([]);
    expect(await getSequenceWithPath(24)).toMatchObject({ sequence: 'MKTW' });
  });

  it('refuses minting accepted assembly source provenance from the old catalog kind alone', async () => {
    await expect(resolveAcceptedSourceIdentity(documentId, 'sha256:snapshot')).rejects.toThrow(
      'FASTA_KIND_CLASSIFICATION_REQUIRED'
    );
  });

  it('fences actual native primer binding publication from a cached DNA row until classification', async () => {
    const artifactPath = join(root, 'Canonical.primer.json');
    const artifact = await buildPrimerArtifact({
      id: 'canonical-cached-target-primer',
      catalogNumber: 'P991',
      name: 'Canonical',
      sequence: 'ACGT',
      workspaceRoot: root,
      artifactPath,
      binding: {
        id: 'canonical-cached-binding',
        targetDocumentId: documentId,
        targetFilePath: path,
        targetLength: 4,
        targetTopology: 'linear',
        targetFileContentHash: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
        targetNormalizedSequenceHash: `sha256:${createHash('sha256').update('MKTW').digest('hex')}`,
        start: 0,
        end: 4,
        strand: 1,
      },
    });
    const content = serializePrimerArtifact(artifact);
    writeFileSync(artifactPath, content);
    await client.registerCatalogEntity({
      id: artifact.id,
      type: 'primer',
      name: artifact.name,
      locator: `waypoint://primer/${artifact.id}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata: { artifactRevision: artifact.artifactRevision },
    });
    await client.bindCatalogEntityFile({
      entityId: artifact.id,
      path: artifactPath,
      fileKind: 'primer-artifact',
      workspaceRoot: root,
      contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    const projection = primerLegacyProjectionFromArtifact(artifact, workspaceId, [
      { binding: artifact.bindings[0], sequenceId: 24 },
    ]);
    await expect(client.replacePrimerProjection(projection, root)).rejects.toThrow(
      'FASTA_KIND_CLASSIFICATION_REQUIRED'
    );
    expect(fixture.db.prepare('SELECT * FROM primers').all()).toEqual([]);
    expect(fixture.db.prepare('SELECT * FROM primer_bindings').all()).toEqual([]);
    expect(readFileSync(artifactPath, 'utf8')).toBe(content);
    const inspected = await client.getFastaKindAuthority({ path, workspaceRoot: root });
    await client.classifyFasta({
      path,
      workspaceRoot: root,
      kind: 'sequence',
      expectedRevision: inspected.revision,
    });
    await client.replacePrimerProjection(projection, root);
    expect(fixture.db.prepare('SELECT primer_id,sequence_id FROM primer_bindings').all()).toEqual([
      { primer_id: artifact.id, sequence_id: 24 },
    ]);
  });

  it('restores normal source and target behavior after explicit native DNA classification', async () => {
    const inspected = await client.getFastaKindAuthority({ path, workspaceRoot: root });
    await client.classifyFasta({
      path,
      workspaceRoot: root,
      kind: 'sequence',
      expectedRevision: inspected.revision,
    });
    expect((await addRegion()).regionId).toEqual(expect.any(String));
    expect(await loadSourceSequenceForKey(documentId)).toMatchObject({
      sequence: 'MKTW',
      length: 4,
    });
    expect(await buildFileDnaSequenceRef(path, { workspaceRoot: root, documentId })).toMatchObject({
      documentId,
      sequenceId: 24,
      length: 4,
    });
    expect(await client.getFastaKindReadAuthority({ path, workspaceRoot: root })).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      entityId: documentId,
      objectUuid: 'legacy-cached-object',
    });
    expect(readFileSync(path, 'utf8')).toBe('>Legacy\nMKTW\n');
  });
});
