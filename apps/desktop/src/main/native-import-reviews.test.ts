import { ensureSequenceIndexInDb } from './sequence-index-command';
/** @vitest-environment node */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

import { createNativeImportReviews } from './native-import-reviews';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { queryLimsEntitiesInDb, defineLimsSchemaInDb } from './lims';
import { parseEntityArtifact } from '../shared/entity-artifact';
import { parseImportSetManifest } from '../shared/registry-artifacts/import-set-core';
import * as XLSX from 'xlsx';
import { createHash, randomUUID } from 'node:crypto';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { createSequenceIdentityRepository } from '../db/sequence-identity-repository';
import { persistRichPastePrimerBindingsInMain } from './native-rich-paste-primer-bindings';
import type { PersistRichPastePrimerBindingsInput } from '../shared/primer-artifacts/persist-primer-bindings-core';
import * as sidecarRuntime from './sidecar-session-runtime';
import type { NativeAgentAuthority } from './agent-grant-authority';

let db: Database.Database;
let directory: string;
let root: string;
let profile: string;
let admitted: string[];
const fullAgent = { identityId: 'native-import-test-agent', capabilities: ['*'] };
const createOwner = (
  authorizeAgent: (
    _agent: NativeAgentAuthority,
    required: readonly string[]
  ) => Promise<void> = async () => {}
) => {
  const owner = createNativeImportReviews({
    db: () => db,
    workspaceRoots: () => admitted,
    profileDirectory: () => profile,
    authorizeAgent,
  });
  return {
    ...owner,
    executeAgent: (
      input: Parameters<typeof owner.executeAgent>[0],
      agent: NativeAgentAuthority = fullAgent,
      assertCurrent?: () => void
    ) => owner.executeAgent(input, agent, assertCurrent),
  };
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-import-review-'));
  root = join(directory, 'project');
  profile = join(directory, 'profile');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run(
    'Import project',
    root
  );
  admitted = [root];
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('native retained import review', () => {
  const workspaceAgent = {
    identityId: 'native-import-test-agent',
    capabilities: ['read-workspace', 'write-workspace'],
  };
  const nebSettings = {
    userSetting: { kind: 'neb' as const, prodcode: 'q5-0', polymerase: 'q5' as const },
    userSettingIsExplicit: true,
    conditions: { monovalentMm: 50, divalentMm: 0, dntpMm: 0 },
    concNm: 500,
  };
  it('denies ungranted external primer computation before any apply effect while keeping local review inspection available', async () => {
    const fetch = vi
      .spyOn(sidecarRuntime, 'nativeDocumentFetch')
      .mockRejectedValue(new Error('Unexpected external transmission.'));
    const owner = createOwner();
    const prepared = await owner.executeAgent(
      {
        project: root,
        operation: {
          kind: 'prepare',
          destination: '.',
          source: {
            fileName: 'neb-primer.csv',
            text: 'Name,Sequence\nReviewed DNA,ACGTACGTACGTACGTACGT',
            forcedKind: 'oligo',
            primerTmSettings: nebSettings,
          },
        },
      },
      workspaceAgent
    );
    expect(prepared.phase).toBe('review');
    await expect(
      owner.executeAgent(
        {
          project: root,
          operation: {
            kind: 'execute',
            id: prepared.id,
            expectedRevision: prepared.revision,
            command: { kind: 'apply', requestId: 'denied-neb' },
          },
        },
        workspaceAgent
      )
    ).rejects.toMatchObject({ code: 'IMPORT_REVIEW_CAPABILITY_DENIED', stateChanged: false });
    expect(
      (
        await owner.executeAgent(
          {
            project: root,
            operation: { kind: 'execute', id: prepared.id, command: { kind: 'inspect' } },
          },
          { ...workspaceAgent, capabilities: ['read-workspace'] }
        )
      ).phase
    ).toBe('review');
    expect(db.prepare('SELECT id FROM primers').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM lims_entity').all()).toEqual([]);
    expect(await (await import('node:fs/promises')).readdir(root)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'rna_oligo', sequence: 'ACGUACGUACGUACGUACGU', settings: nebSettings },
    { kind: 'protein', sequence: 'MKWVTFISLLFLFSSAYS', settings: nebSettings },
    {
      kind: 'oligo',
      sequence: 'ACGTACGTACGTACGTACGT',
      settings: {
        ...nebSettings,
        userSetting: { kind: 'local' as const, algorithm: 'santalucia98' as const },
      },
    },
  ])(
    'does not require or send external computation for actual local $kind imports',
    async ({ kind, sequence, settings }) => {
      const fetch = vi
        .spyOn(sidecarRuntime, 'nativeDocumentFetch')
        .mockRejectedValue(new Error('Unexpected external transmission.'));
      const owner = createOwner();
      const prepared = await owner.executeAgent(
        {
          project: root,
          operation: {
            kind: 'prepare',
            destination: '.',
            source: {
              fileName: `local-${kind}.csv`,
              text: `Name,Sequence\nLocal import,${sequence}`,
              forcedKind: kind,
              primerTmSettings: settings,
            },
          },
        },
        workspaceAgent
      );
      const applied = await owner.executeAgent(
        {
          project: root,
          operation: {
            kind: 'execute',
            id: prepared.id,
            expectedRevision: prepared.revision,
            command: { kind: 'apply', requestId: `local-${kind}` },
          },
        },
        workspaceAgent
      );
      expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it('passes only the trusted current external scope to the canonical NEB calculation', async () => {
    const fetch = vi
      .spyOn(sidecarRuntime, 'nativeDocumentFetch')
      .mockImplementation(async () =>
        Response.json({ p1: { tm: 61 }, ta: 60, api_version: 'qualified-test' })
      );
    const authorize = vi.fn(
        async (_agent: NativeAgentAuthority, _required: readonly string[]) => {}
      ),
      owner = createOwner(authorize);
    const agent = {
      ...workspaceAgent,
      capabilities: [...workspaceAgent.capabilities, 'external-compute:tm'],
    };
    const prepared = await owner.executeAgent(
      {
        project: root,
        operation: {
          kind: 'prepare',
          destination: '.',
          source: {
            fileName: 'authorized-neb.csv',
            text: 'Name,Sequence\nAuthorized DNA,ACGTACGTACGTACGTACGT',
            forcedKind: 'oligo',
            primerTmSettings: nebSettings,
          },
        },
      },
      agent
    );
    const applied = await owner.executeAgent(
      {
        project: root,
        operation: {
          kind: 'execute',
          id: prepared.id,
          expectedRevision: prepared.revision,
          command: { kind: 'apply', requestId: 'authorized-neb' },
        },
      },
      agent
    );
    expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/external/neb/tm');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      seq1: 'ACGTACGTACGTACGTACGT',
      granted_capabilities: agent.capabilities,
    });
    expect(
      authorize.mock.calls.some(([, required]) => required.includes('external-compute:tm'))
    ).toBe(true);
  });
  it('keeps a revoked external request from falling back into a successful import', async () => {
    const fetch = vi
      .spyOn(sidecarRuntime, 'nativeDocumentFetch')
      .mockRejectedValue(new Error('Unexpected external transmission.'));
    let externalChecks = 0;
    const owner = createOwner(async (_agent, required) => {
      if (required.includes('external-compute:tm') && ++externalChecks > 1)
        throw new Error('IMPORT_REVIEW_CAPABILITY_DENIED: The external grant was revoked.');
    });
    const agent = {
      ...workspaceAgent,
      capabilities: [...workspaceAgent.capabilities, 'external-compute:tm'],
    };
    const prepared = await owner.executeAgent(
      {
        project: root,
        operation: {
          kind: 'prepare',
          destination: '.',
          source: {
            fileName: 'revoked-neb.csv',
            text: 'Name,Sequence\nRevoked DNA,ACGTACGTACGTACGTACGT',
            forcedKind: 'oligo',
            primerTmSettings: nebSettings,
          },
        },
      },
      agent
    );
    const applied = await owner.executeAgent(
      {
        project: root,
        operation: {
          kind: 'execute',
          id: prepared.id,
          expectedRevision: prepared.revision,
          command: { kind: 'apply', requestId: 'revoked-neb' },
        },
      },
      agent
    );
    expect(applied).toMatchObject({
      phase: 'partial',
      receipt: { changed: false, imported: 0, failed: 1 },
    });
    expect(applied.receipt).not.toHaveProperty('sourcePath');
    expect(await readdir(root)).toEqual([]);
    expect(applied.receipt?.partialEffects?.join(' ')).toContain('revoked');
    expect(fetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT id FROM primers').all()).toEqual([]);
  });
  it.each([
    { kind: 'strain', text: 'Name,Genotype\nNative source strain,deltaA\n' },
    { kind: 'oligo', text: 'Name,Sequence\nNative source primer,ACGTACGTACGTACGTACGT\n' },
    { kind: 'protein', text: 'Name,Sequence\nNative source protein,MKWVTFISLLFLFSSAYS\n' },
  ])(
    'retains the exact admitted $kind source bytes in canonical import-set provenance',
    async ({ kind, text }) => {
      const fileName = `native-source-${kind}.csv`,
        sourcePath = join(root, fileName);
      await writeFile(sourcePath, text);
      const owner = createOwner();
      const prepared = await owner.call({
        kind: 'prepare',
        workspaceRoot: root,
        destinationDir: root,
        source: { fileName, sourcePath, forcedKind: kind },
      });
      const applied = await owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: { kind: 'apply', requestId: `source-${kind}` },
      });
      expect(applied.phase).toBe('applied');
      const manifest = parseImportSetManifest(
        await readFile(join(root, applied.receipt!.importSet!.manifestRelativePath), 'utf8')
      );
      const expectedFingerprint = `sha256:${createHash('sha256').update(text).digest('hex')}`;
      expect(prepared.sourceFingerprint).toBe(expectedFingerprint);
      expect(manifest.source.fingerprint).toBe(expectedFingerprint);
      expect(manifest.source.snapshotRelativePath).toEqual(expect.any(String));
      expect(await readFile(join(root, manifest.source.snapshotRelativePath!), 'utf8')).toBe(text);
      expect(await readFile(sourcePath, 'utf8')).toBe(text);
    }
  );
  it.each([
    {
      kind: 'oligo',
      fileName: 'pasted-oligo.tsv',
      destination: '.',
      text: 'Name\tSequence\nPaste Primer A\tGTAAAACGACGGCCAGT\n',
    },
    {
      kind: 'rna_oligo',
      fileName: 'rna-orders.csv',
      destination: 'orders/oligos',
      text: 'Name,Sequence\nModified RNA order,/5Phos/rArCrGrUrArCrGrUrArC\n',
    },
    {
      kind: 'protein',
      fileName: 'real-protein.csv',
      destination: 'orders/proteins',
      text: 'Name,Sequence\nNative protein,MKWVTFISLLFLFSSAYS\n',
    },
  ])(
    'publishes $kind artifacts and import-set provenance without copying the source table into the project',
    async ({ kind, fileName, destination, text }) => {
      const destinationDir = join(root, destination);
      await mkdir(destinationDir, { recursive: true });
      const owner = createOwner();
      const prepared = await owner.call({
        kind: 'prepare',
        workspaceRoot: root,
        destinationDir,
        source: { fileName, text, forcedKind: kind },
      });
      const applied = await owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: { kind: 'apply', requestId: `no-source-copy-${kind}` },
      });
      expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
      expect(await readdir(root)).not.toContain(fileName);
      expect(await readdir(destinationDir)).not.toContain(fileName);
      expect(applied.receipt).not.toHaveProperty('sourcePath');
      const manifest = parseImportSetManifest(
        await readFile(join(root, applied.receipt!.importSet!.manifestRelativePath), 'utf8')
      );
      expect(await readFile(join(root, manifest.source.snapshotRelativePath!), 'utf8')).toBe(text);
    }
  );
  it('keeps the source table beside generic record artifacts', async () => {
    const destinationDir = join(root, 'orders', 'strains');
    await mkdir(destinationDir, { recursive: true });
    const text = 'Name,Genotype\nPasted strain,deltaA\n';
    const owner = createOwner();
    const prepared = await owner.call({
      kind: 'prepare',
      workspaceRoot: root,
      destinationDir,
      source: { fileName: 'pasted-strain.csv', text, forcedKind: 'strain' },
    });
    const applied = await owner.call({
      kind: 'execute',
      id: prepared.id,
      expectedRevision: prepared.revision,
      command: { kind: 'apply', requestId: 'generic-source-copy' },
    });
    expect(applied).toMatchObject({
      phase: 'applied',
      receipt: { imported: 1, sourcePath: 'orders/strains/pasted-strain.csv' },
    });
    expect(await readFile(join(root, applied.receipt!.sourcePath!), 'utf8')).toBe(text);
  });
  it.each([
    {
      kind: 'custom_primer',
      family: 'primer',
      sequence: 'ACGTACGTACGTACGTACGT',
      suffix: '.primer.json',
    },
    {
      kind: 'custom_protein',
      family: 'protein',
      sequence: 'MKWVTFISLLFLFSSAYS',
      suffix: '.entity.json',
    },
  ])(
    'retains $family schema fields through its canonical scientific writer',
    async ({ kind, family, sequence, suffix }) => {
      defineLimsSchemaInDb(db, {
        kind: 'entity',
        name: kind,
        baseKind: family,
        displayName: kind,
        fields: [{ key: 'assay', label: 'Assay', type: 'text', required: true }],
      });
      const owner = createOwner();
      const prepared = await owner.executeAgent({
        project: root,
        operation: {
          kind: 'prepare',
          destination: '.',
          source: {
            fileName: `${kind}.csv`,
            text: `Name,Sequence,Assay\nDerived molecule,${sequence},ScreenA`,
            forcedKind: kind,
          },
        },
      });
      const mapped = await owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: {
          kind: 'set-mappings',
          mappings: [{ sourceColumn: 'Assay', mappedField: 'fields.assay', mappingMode: 'mapped' }],
        },
      });
      const applied = await owner.call({
        kind: 'execute',
        id: mapped.id,
        expectedRevision: mapped.revision,
        command: { kind: 'apply', requestId: kind },
      });
      expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
      expect(applied.receipt!.artifactPaths[0]).toContain(suffix);
      expect(queryLimsEntitiesInDb(db, { kind })[0].fields.assay).toBe('ScreenA');
    }
  );
  it('settles copied primer bindings through the same artifact writer against the exact published sequence', async () => {
    const owner = createOwner();
    for (const source of [
      {
        fileName: 'target.fasta',
        text: '>Binding target\nACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT',
        forcedKind: 'sequence',
      },
      {
        fileName: 'bound-primer.csv',
        text: 'Name,Sequence\nBound native primer,ACGTACGTACGTACGTACGT',
        forcedKind: 'oligo',
      },
    ]) {
      const prepared = await owner.call({
        kind: 'prepare',
        workspaceRoot: root,
        destinationDir: root,
        source,
      });
      const applied = await owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: { kind: 'apply', requestId: source.fileName },
      });
      expect(applied.phase).toBe('applied');
    }
    const target = queryLimsEntitiesInDb(db, { kind: 'sequence' })[0];
    const primer = queryLimsEntitiesInDb(db, { kind: 'oligo' })[0];
    const resolved = await createNativeSequenceDocumentResolver({
      db: () => db,
      workspaceRoots: () => admitted,
    })({ operationId: 'binding-proof', targetDocumentId: target.id });
    const database = {
      select: async <T>(sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).all(...params) as T,
      execute: async (sql: string, params: readonly unknown[] = []) => {
        const result = db.prepare(sql).run(...params);
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      },
    };
    const sequenceId = await createSequenceIdentityRepository({
      ...database,
      ensureSequenceIndex: async (input) => ensureSequenceIndexInDb(db, input),
    }).ensureSequenceIdentity(target.id, resolved.sourcePath, 'Binding target', 40, false, root);
    const hash = `sha256:${createHash('sha256')
      .update(await readFile(resolved.sourcePath))
      .digest('hex')}`;
    const input: PersistRichPastePrimerBindingsInput = {
      draftLineageId: randomUUID(),
      expectedFileSha256: hash,
      bindings: [
        {
          pendingId: randomUUID(),
          primerId: primer.id,
          start: 0,
          end: 20,
          strand: 1,
          sourceWorkspaceRoot: root,
        },
      ],
      targetDocumentId: target.id,
      targetFilePath: resolved.sourcePath,
      targetSequenceId: sequenceId,
      targetWorkspaceRoot: root,
    };
    await persistRichPastePrimerBindingsInMain(input, {
      db,
      workspaceRoots: () => admitted,
      assertCurrent: () => {},
      expectedTargetContentHash: hash,
    });
    await persistRichPastePrimerBindingsInMain(input, {
      db,
      workspaceRoots: () => admitted,
      assertCurrent: () => {},
      expectedTargetContentHash: hash,
    });
    expect(
      db
        .prepare(
          'SELECT primer_id,sequence_id,binding_start,binding_end,strand FROM primer_bindings'
        )
        .all()
    ).toEqual([
      {
        primer_id: primer.id,
        sequence_id: sequenceId,
        binding_start: 0,
        binding_end: 20,
        strand: 1,
      },
    ]);
    await expect(
      persistRichPastePrimerBindingsInMain(input, {
        db,
        workspaceRoots: () => admitted,
        assertCurrent: () => {},
        expectedTargetContentHash: `sha256:${'0'.repeat(64)}`,
      })
    ).rejects.toThrow('published target changed');
  });
  it('keeps actual provisioned schema mappings and numeric values in authoritative records', async () => {
    defineLimsSchemaInDb(db, {
      kind: 'entity',
      name: 'custom_material',
      displayName: 'Custom material',
      fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }],
    });
    const owner = createOwner();
    const prepared = await owner.executeAgent({
      project: root,
      operation: {
        kind: 'prepare',
        destination: '.',
        source: {
          fileName: 'materials.csv',
          text: 'Name,Volume\nCustom import,4.5',
          forcedKind: 'custom_material',
        },
      },
    });
    const mapped = await owner.call({
      kind: 'execute',
      id: prepared.id,
      expectedRevision: prepared.revision,
      command: {
        kind: 'set-mappings',
        mappings: [{ sourceColumn: 'Volume', mappedField: 'fields.amount', mappingMode: 'mapped' }],
      },
    });
    const applied = await owner.call({
      kind: 'execute',
      id: mapped.id,
      expectedRevision: mapped.revision,
      command: { kind: 'apply', requestId: 'custom-schema' },
    });
    expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1 } });
    const artifact = parseEntityArtifact(
      await readFile(join(root, applied.receipt!.artifactPaths[0]), 'utf8')
    );
    expect(artifact.fields.amount).toBe(4.5);
    expect(artifact.schemaSnapshot?.name).toBe('custom_material');
    const manifest = parseImportSetManifest(
      await readFile(join(root, applied.receipt!.importSet!.manifestRelativePath), 'utf8')
    );
    expect(manifest.partitions[0].forcedKind).toBe('custom_material');
  });

  it('retains both workbook sheet partitions when reviews are applied independently', async () => {
    const workbook = XLSX.utils.book_new();
    for (const [name, strain] of [
      ['First', 'Sheet one strain'],
      ['Second', 'Sheet two strain'],
    ])
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ['Name', 'Genotype'],
          [strain, 'deltaA'],
        ]),
        name
      );
    const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const owner = createOwner();
    let manifestPath = '';
    for (const sheetName of ['First', 'Second']) {
      const prepared = await owner.call({
        kind: 'prepare',
        workspaceRoot: root,
        destinationDir: root,
        source: { fileName: 'book.xlsx', arrayBuffer, sheetName, forcedKind: 'strain' },
      });
      const applied = await owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: { kind: 'apply', requestId: sheetName },
      });
      expect(applied.receipt?.imported).toBe(1);
      manifestPath = applied.receipt!.importSet!.manifestRelativePath;
    }
    const manifest = parseImportSetManifest(await readFile(join(root, manifestPath), 'utf8'));
    expect(manifest.partitions.map((partition) => partition.sourcePartition)).toEqual([
      'First',
      'Second',
    ]);
    expect(manifest.partitions.flatMap((partition) => partition.members)).toHaveLength(2);
  });

  it('uses the existing managed sequence package ingress for a reviewed FASTA source', async () => {
    const owner = createOwner();
    const prepared = await owner.call({
      kind: 'prepare',
      workspaceRoot: root,
      destinationDir: root,
      source: {
        fileName: 'native-sequence.fasta',
        text: '>Native reviewed DNA\nACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT',
        forcedKind: 'sequence',
      },
    });
    const applied = await owner.call({
      kind: 'execute',
      id: prepared.id,
      expectedRevision: prepared.revision,
      command: { kind: 'apply', requestId: 'sequence-package' },
    });
    expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
    expect(queryLimsEntitiesInDb(db, { kind: 'sequence' })[0].fields.sequence).toMatchObject({
      mode: 'file',
    });
  });
  it.each([
    {
      kind: 'oligo' as const,
      name: 'Native primer',
      sequence: 'ACGTACGTACGTACGTACGT',
      suffix: '.primer.json',
    },
    {
      kind: 'rna_oligo' as const,
      name: 'Native RNA',
      sequence: 'ACGUACGUACGUACGUACGU',
      suffix: '.primer.json',
    },
    {
      kind: 'protein' as const,
      name: 'Native protein',
      sequence: 'MKWVTFISLLFLFSSAYS',
      suffix: '.entity.json',
    },
  ])(
    'uses the existing canonical $kind writer without a renderer or open wizard',
    async ({ kind, name, sequence, suffix }) => {
      const owner = createOwner();
      const prepared = await owner.executeAgent({
        project: 'Import project',
        operation: {
          kind: 'prepare',
          destination: '.',
          source: {
            fileName: 'molecules.csv',
            text: `Name,Sequence\n${name},${sequence}`,
            forcedKind: kind,
          },
        },
      });
      expect(prepared.canApply).toBe(true);
      const applied = await owner.executeAgent({
        project: root,
        operation: {
          kind: 'execute',
          id: prepared.id,
          expectedRevision: prepared.revision,
          command: { kind: 'apply', requestId: `apply-${kind}` },
        },
      });
      expect(applied).toMatchObject({ phase: 'applied', receipt: { imported: 1, failed: 0 } });
      expect(applied.receipt!.artifactPaths[0]).toContain(suffix);
      const [entity] = queryLimsEntitiesInDb(db, { kind });
      expect(entity.name).toBe(name);
      expect(await readFile(join(root, applied.receipt!.artifactPaths[0]), 'utf8')).toContain(name);
      if (kind !== 'protein')
        expect(db.prepare('SELECT name FROM primers').all()).toEqual([{ name }]);
    }
  );

  it('retains independent review identities, exact acceptance and apply receipts across owner restart', async () => {
    const source = {
      fileName: 'strains.csv',
      text: 'Name,Genotype\nKept strain,deltaA\nRejected strain,deltaB',
      forcedKind: 'strain' as const,
    };
    const owner = createOwner();
    const prepared = await owner.call({
      kind: 'prepare',
      workspaceRoot: root,
      destinationDir: root,
      source,
    });
    const other = await owner.call({
      kind: 'prepare',
      workspaceRoot: root,
      destinationDir: root,
      source,
    });
    expect(other.id).not.toBe(prepared.id);
    expect(prepared.records).toHaveLength(2);
    const rejected = prepared.records.find(
      (record) => record.entityDraft.name === 'Rejected strain'
    )!;
    const updated = await owner.call({
      kind: 'execute',
      id: prepared.id,
      expectedRevision: prepared.revision,
      command: { kind: 'set-records-accepted', recordIds: [rejected.id], accepted: false },
    });
    const restarted = createOwner();
    const inspected = await restarted.call({
      kind: 'execute',
      id: prepared.id,
      command: { kind: 'inspect', limit: 1 },
    });
    expect(inspected.revision).toBe(updated.revision);
    expect(inspected.records).toHaveLength(1);
    expect(inspected.nextOffset).toBe(1);
    const request = {
      kind: 'execute' as const,
      id: prepared.id,
      expectedRevision: updated.revision,
      command: { kind: 'apply' as const, requestId: 'apply-once' },
    };
    const applied = await restarted.call(request);
    expect(applied.phase).toBe('applied');
    expect(applied.receipt?.imported).toBe(1);
    expect(applied.receipt?.artifactPaths).toHaveLength(1);
    const artifact = parseEntityArtifact(
      await readFile(join(root, applied.receipt!.artifactPaths[0]), 'utf8')
    );
    expect(artifact.name).toBe('Kept strain');
    expect(artifact.source.type).toBeUndefined();
    expect(
      db
        .prepare(
          'SELECT id,type,storage_type,locator,workspace_id FROM catalog_entities WHERE id=?'
        )
        .get(artifact.id)
    ).toEqual({
      id: artifact.id,
      type: 'file',
      storage_type: 'file',
      locator: `file://${join(root, applied.receipt!.artifactPaths[0])}`,
      workspace_id: 7,
    });
    expect(
      db.prepare('SELECT path FROM catalog_entity_files WHERE entity_id=?').all(artifact.id)
    ).toEqual([{ path: join(root, applied.receipt!.artifactPaths[0]) }]);
    expect(queryLimsEntitiesInDb(db, { kind: 'strain' }).map((record) => record.name)).toEqual([
      'Kept strain',
    ]);
    expect(await createOwner().call(request)).toEqual(applied);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM lims_audit WHERE event_type='import_batch_applied'")
        .get()
    ).toEqual({
      count: 1,
    });
  });

  it('rejects a changed physical source, stale decisions and revoked project authority before writes', async () => {
    const path = join(root, 'strains.csv');
    await writeFile(path, 'Name,Genotype\nSource strain,deltaA');
    const owner = createOwner();
    const prepared = await owner.call({
      kind: 'prepare',
      workspaceRoot: root,
      destinationDir: root,
      source: { fileName: 'strains.csv', sourcePath: path, forcedKind: 'strain' },
    });
    await expect(
      owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: 'obsolete',
        command: { kind: 'cancel' },
      })
    ).rejects.toThrow('STALE_IMPORT_REVIEW');
    await writeFile(path, 'Name,Genotype\nChanged strain,deltaB');
    await expect(
      owner.call({
        kind: 'execute',
        id: prepared.id,
        expectedRevision: prepared.revision,
        command: { kind: 'apply', requestId: 'changed-source' },
      })
    ).rejects.toThrow('IMPORT_SOURCE_CHANGED');
    admitted = [];
    await expect(
      owner.call({ kind: 'execute', id: prepared.id, command: { kind: 'inspect' } })
    ).rejects.toThrow('IMPORT_PROJECT_UNAVAILABLE');
    expect(queryLimsEntitiesInDb(db, { kind: 'strain' })).toEqual([]);
  });

  it('reports a changed-source agent refusal as a typed no-effect outcome', async () => {
    const path = join(root, 'agent-source.csv');
    await writeFile(path, 'Name,Genotype\nReviewed strain,deltaA');
    const owner = createOwner();
    const prepared = await owner.executeAgent({
      project: root,
      operation: {
        kind: 'prepare',
        destination: '.',
        source: { fileName: 'agent-source.csv', sourcePath: path, forcedKind: 'strain' },
      },
    });
    await writeFile(path, 'Name,Genotype\nOutside changed strain,deltaB');
    await expect(
      owner.executeAgent({
        project: root,
        operation: {
          kind: 'execute',
          id: prepared.id,
          expectedRevision: prepared.revision,
          command: { kind: 'apply', requestId: 'changed-agent-source' },
        },
      })
    ).rejects.toMatchObject({
      code: 'IMPORT_SOURCE_CHANGED',
      stateChanged: false,
      partialEffects: [],
    });
    expect(
      (await owner.call({ kind: 'execute', id: prepared.id, command: { kind: 'inspect' } })).phase
    ).toBe('review');
    expect(queryLimsEntitiesInDb(db, { kind: 'strain' })).toEqual([]);
  });
});
