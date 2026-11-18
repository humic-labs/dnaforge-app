// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { canonicalProtocolJson, parseProtocolPackage } from '@waypoint/domain-services';
import type {
  NativeProtocolCreationResult,
  NativeProtocolPackageSnapshot,
} from '../shared/protocol-packages';
import type { NativeProtocolRecordRunValuesRequest } from '../shared/protocol-value-edits';
let db: Database.Database;
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { createNativeProtocolPackages } from './native-protocol-packages';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';

it('saves typed declarations and Run values through durable file SQLite HTTP recovery without inventory effects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-protocol-values-'))),
    project = join(root, 'project');
  mkdirSync(project);
  db = openFileTestDb(join(root, 'catalog.sqlite'));
  ensureSchema(db, join(root, 'catalog.sqlite'));
  db.prepare(
    "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Values project',?,'values-project','writable',1)"
  ).run(project);
  rememberOriginalDefaultProject(db, 41);
  const projectAuthority = createRegisteredProjectAuthority({
    db: () => db,
    managedRootDir: () => join(root, 'managed'),
  });
  const workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
  let interrupt = false;
  const make = () =>
    createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(root, 'profile'),
      actor: () => 'native:values',
      afterFilePublished: () => {
        if (interrupt) {
          interrupt = false;
          throw Error('File published before catalog');
        }
      },
    });
  let owner = make();
  createNativeInventoryOwner({
    db: () => db,
    projectAuthority,
    protocolSources: owner,
    profileKey: 'a'.repeat(64),
    actor: () => 'native:values',
  }).initialize();
  const ready = (result: NativeProtocolCreationResult): NativeProtocolPackageSnapshot => {
    expect(result.kind, JSON.stringify(result)).toBe('ready');
    if (result.kind !== 'ready') throw Error(JSON.stringify(result));
    return result.package;
  };
  const scope = { project: 'values-project' };
  const receiptPath = (requestId: string) =>
    join(
      root,
      'profile',
      'protocol-package-operations',
      createHash('sha256').update(`${scope.project}\0${requestId}`).digest('hex') + '.json'
    );
  const events = () => db.prepare('SELECT * FROM catalog_entity_events ORDER BY id').all();
  const physical = () =>
    JSON.stringify({
      state: db.prepare('SELECT * FROM inventory_state').all(),
      history: db.prepare('SELECT * FROM inventory_journal').all(),
    });
  const authority = { ownerInstanceId: 'values-owner', token: 'values-token' };
  const server = await startNativeDocumentCommandServer({
    owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
    protocols: {
      createProtocol: (...args) => owner.createProtocol(...args),
      startRun: (...args) => owner.startRun(...args),
      editProtocolDeclarations: (...args) => owner.editProtocolDeclarations(...args),
      recordRunValues: (...args) => owner.recordRunValues(...args),
      savePackage: (...args) => owner.savePackage(...args),
      inspectCreation: (...args) => owner.inspectCreation(...args),
      recoverCreation: (...args) => owner.recoverCreation(...args),
      readPackage: (...args) => owner.readPackage(...args),
      readSavedProtocol: (...args) => owner.readSavedProtocol(...args),
      listPackages: (...args) => owner.listPackages(...args),
    },
    projectAuthority,
    getAuthority: () => authority,
    authorizeProtocolsAgent: async () => {},
  });
  const envelope = (operation: unknown, capabilities = ['read-workspace', 'write-workspace']) => ({
    ownerInstanceId: authority.ownerInstanceId,
    projectScope: { kind: 'project-roots', roots: [project] },
    command: 'protocols.execute',
    request: { operation },
    agent: { identityId: 'values-agent', capabilities },
  });
  const call = async (operation: unknown, capabilities?: string[]) => {
    const response = await fetch(server.url + '/internal/native-documents/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': authority.token,
      },
      body: JSON.stringify(envelope(operation, capabilities)),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const beforePhysical = physical();
    const create = { ...scope, requestId: 'old-create', title: 'Typed Protocol' };
    let protocol = ready(await owner.createProtocol(create));
    const legacyRaw = parseProtocolPackage(protocol.originalText).raw;
    legacyRaw.inputs = [
      {
        key: 'legacy_quantity',
        label: 'Original quantity',
        required: false,
        description: null,
        valueType: {
          kind: 'quantity',
          unitDimension: null,
          preferredUnit: 'uL',
          retained: 'type-extra',
        },
        retained: 'row-extra',
      },
    ];
    legacyRaw.unknown = { preserved: ['exact', 0, false] };
    const oldSave = {
      ...scope,
      entityId: protocol.entityId,
      requestId: 'old-save',
      expectedSourceSha256: protocol.sourceSha256,
      originalText: canonicalProtocolJson(legacyRaw) + '\n',
    };
    protocol = ready(await owner.savePackage(oldSave));
    const oldReceipts = new Map(
      ['old-create', 'old-save'].map((id) => [id, readFileSync(receiptPath(id))])
    );
    const declarations = {
      ...scope,
      entityId: protocol.entityId,
      requestId: 'typed-declarations',
      expectedSourceSha256: protocol.sourceSha256,
      choices: {
        reason: 'Define explicit requirements',
        upserts: [
          {
            direction: 'inputs' as const,
            key: 'sample',
            label: 'Sample name',
            required: true,
            description: null,
            valueType: { kind: 'text' as const },
          },
          {
            direction: 'outputs' as const,
            key: 'count',
            label: 'Recorded count',
            required: false,
            description: 'Explicit count',
            valueType: { kind: 'number' as const },
          },
        ],
      },
    };
    const denied = await call({ kind: 'edit-protocol-declarations', ...declarations }, [
      'read-workspace',
    ]);
    expect(denied.body.result.code).toBe('PROTOCOL_CAPABILITY_DENIED');
    const badBody = await call({
      kind: 'edit-protocol-declarations',
      ...declarations,
      originalText: 'caller source',
    });
    expect(badBody.status).toBe(400);
    const address = new URL(server.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify(
        envelope({ kind: 'edit-protocol-declarations', ...declarations })
      );
      await new Promise<void>((resolve, reject) =>
        socket.write(
          [
            'POST /internal/native-documents/call HTTP/1.1',
            `Host: ${address.host}`,
            'Content-Type: application/json',
            `X-DNAForge-Native-Document-Authority: ${authority.token}`,
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'),
          (error) => (error ? reject(error) : resolve())
        )
      );
      let result: NativeProtocolCreationResult = {
        kind: 'missing',
        requestId: declarations.requestId,
      };
      for (let i = 0; i < 200 && result.kind !== 'ready'; i++) {
        result = await owner.inspectCreation({ ...scope, requestId: declarations.requestId });
        if (result.kind !== 'ready') await new Promise((resolve) => setTimeout(resolve, 5));
      }
      protocol = ready(result);
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    expect(JSON.parse(readFileSync(receiptPath(declarations.requestId), 'utf8'))).toMatchObject({
      version: 2,
      phase: 'ready',
      request: { kind: 'edit-protocol-declarations', ...declarations },
      output: { changed: true },
      actor: 'agent:values-agent',
    });
    const declaredRaw = parseProtocolPackage(protocol.originalText).raw;
    expect((declaredRaw.inputs as unknown[])[0]).toEqual((legacyRaw.inputs as unknown[])[0]);
    expect(declaredRaw.unknown).toEqual(legacyRaw.unknown);
    const originalDeclared = protocol.originalText;
    const laterRaw = parseProtocolPackage(protocol.originalText).raw;
    laterRaw.title = 'Later Protocol title';
    protocol = ready(
      await owner.savePackage({
        ...scope,
        requestId: 'later-title',
        entityId: protocol.entityId,
        expectedSourceSha256: protocol.sourceSha256,
        originalText: canonicalProtocolJson(laterRaw) + '\n',
      })
    );
    expect(ready(await owner.editProtocolDeclarations(declarations)).originalText).toBe(
      originalDeclared
    );
    await expect(owner.editProtocolDeclarations({ ...declarations, project })).rejects.toThrow(
      'PROTOCOL_REQUEST_CONFLICT'
    );
    await expect(
      owner.editProtocolDeclarations({
        ...declarations,
        choices: { ...declarations.choices, upserts: [...declarations.choices.upserts].reverse() },
      })
    ).rejects.toThrow('PROTOCOL_REQUEST_CONFLICT');
    expect(ready(await owner.createProtocol(create)).entityId).toBe(protocol.entityId);
    expect(ready(await owner.savePackage(oldSave)).originalText).toBe(oldSave.originalText);
    for (const [id, bytes] of oldReceipts) expect(readFileSync(receiptPath(id))).toEqual(bytes);
    const start = {
      ...scope,
      requestId: 'start-values',
      title: 'Typed Run',
      protocolId: protocol.entityId,
      expectedSourceSha256: protocol.sourceSha256,
    };
    let run = ready(await owner.startRun(start));
    const initialRun = parseProtocolPackage(run.originalText).raw;
    expect([initialRun.inputs, initialRun.outputs, initialRun.measurements]).toEqual([[], [], []]);
    const runLegacy = parseProtocolPackage(run.originalText).raw;
    runLegacy.inputs = [
      {
        key: 'legacy_quantity',
        label: 'Legacy actual',
        value: {
          type: 'quantity',
          lexical: '3uL',
          value: 3,
          unit: 'uL',
          unitCompatibility: 'recognized',
          extra: 'keep',
        },
        extra: { keep: true },
      },
    ];
    runLegacy.measurements = [
      {
        key: 'legacy_attachment',
        label: 'Attachment',
        value: {
          type: 'attachment',
          hash: `sha256:${'a'.repeat(64)}`,
          fileName: 'evidence.txt',
          extra: true,
        },
        recordedAt: '2026-11-01T12:00:00.000Z',
      },
    ];
    run = ready(
      await owner.savePackage({
        ...scope,
        entityId: run.entityId,
        requestId: 'legacy-actuals',
        expectedSourceSha256: run.sourceSha256,
        originalText: canonicalProtocolJson(runLegacy) + '\n',
      })
    );
    const frozen = runLegacy.frozenProtocol as { definitionSha256: `sha256:${string}` };
    const values: NativeProtocolRecordRunValuesRequest = {
      ...scope,
      entityId: run.entityId,
      requestId: 'typed-values',
      expectedSourceSha256: run.sourceSha256,
      choices: {
        reason: 'Record ordinary Run values',
        upserts: [
          {
            collection: 'inputs',
            key: 'sample',
            label: 'Sample name',
            value: { type: 'text', value: '' },
            origin: { kind: 'frozen-declaration', definitionSha256: frozen.definitionSha256 },
          },
          {
            collection: 'outputs',
            key: 'count',
            label: 'Recorded count',
            value: { type: 'number', value: 0 },
            origin: { kind: 'frozen-declaration', definitionSha256: frozen.definitionSha256 },
          },
          {
            collection: 'measurements',
            key: 'flag',
            label: 'Recorded flag',
            value: { type: 'boolean', value: false },
            origin: { kind: 'local-actual' },
          },
          {
            collection: 'measurements',
            key: 'date',
            label: 'Recorded date',
            value: { type: 'date', value: '2026-11-17T12:30:00.000Z' },
            origin: { kind: 'local-actual' },
          },
        ],
      },
    };
    interrupt = true;
    const pending = await call({ kind: 'record-run-values', ...values });
    expect(pending.body.result.kind).toBe('pending');
    const published = readFileSync(run.path, 'utf8');
    expect(JSON.parse(readFileSync(receiptPath(values.requestId), 'utf8'))).toMatchObject({
      version: 2,
      phase: 'published',
      text: published,
    });
    owner = make();
    run = ready(await owner.recoverCreation({ ...scope, requestId: values.requestId }));
    expect(run.originalText).toBe(published);
    const actual = parseProtocolPackage(run.originalText).raw;
    expect((actual.inputs as unknown[])[0]).toEqual((runLegacy.inputs as unknown[])[0]);
    expect((actual.measurements as unknown[])[0]).toEqual((runLegacy.measurements as unknown[])[0]);
    expect(actual.frozenProtocol).toEqual(initialRun.frozenProtocol);
    expect(actual.outputs).toEqual([
      { key: 'count', label: 'Recorded count', value: { type: 'number', value: 0 } },
    ]);
    expect(actual.measurements).toContainEqual(
      expect.objectContaining({
        key: 'flag',
        value: { type: 'boolean', value: false },
        recordedAt: expect.any(String),
      })
    );
    const priorEvents = events();
    expect(
      ready(
        await owner.recordRunValues({
          ...values,
          requestId: 'same-values',
          expectedSourceSha256: run.sourceSha256,
        })
      ).originalText
    ).toBe(run.originalText);
    expect(events()).toEqual(priorEvents);
    expect(JSON.parse(readFileSync(receiptPath('same-values'), 'utf8')).output.changed).toBe(false);
    const bad = (upsert: unknown) => ({
      ...values,
      requestId:
        'refused-' + readdirSync(join(root, 'profile', 'protocol-package-operations')).length,
      expectedSourceSha256: run.sourceSha256,
      choices: { reason: 'Explicit invalid input', upserts: [upsert] },
    });
    await expect(
      owner.recordRunValues(bad({ ...values.choices.upserts[0], origin: { kind: 'local-actual' } }))
    ).rejects.toThrow('shadow');
    await expect(
      owner.recordRunValues(
        bad({ ...values.choices.upserts[1], value: { type: 'boolean', value: false } })
      )
    ).rejects.toThrow('type');
    await expect(
      owner.recordRunValues(
        bad({
          collection: 'inputs',
          key: 'legacy_quantity',
          label: 'Forbidden overwrite',
          value: { type: 'text', value: 'x' },
          origin: { kind: 'frozen-declaration', definitionSha256: frozen.definitionSha256 },
        })
      )
    ).rejects.toThrow();
    await expect(
      owner.recordRunValues(
        bad({
          ...values.choices.upserts[0],
          value: { type: 'number', value: Number.MAX_SAFE_INTEGER + 1 },
        })
      )
    ).rejects.toThrow();
    await expect(owner.recordRunValues({ ...values, requestId: 'stale-source' })).rejects.toThrow(
      'PROTOCOL_SAVE_SOURCE_CHANGED'
    );
    const larger = {
      ...values,
      requestId: 'large-receipt',
      expectedSourceSha256: run.sourceSha256,
      choices: {
        reason: 'Bound complete operation',
        upserts: [
          {
            collection: 'measurements',
            key: 'large',
            label: 'Large',
            value: { type: 'text', value: 'x'.repeat(8 * 1024 * 1024) },
            origin: { kind: 'local-actual' },
          },
        ],
      },
    };
    await expect(owner.recordRunValues(larger)).rejects.toThrow('PROTOCOL_EDIT_RECEIPT_TOO_LARGE');
    expect(existsSync(receiptPath('large-receipt'))).toBe(false);
    const deniedWrite = await owner.recordRunValues(
      {
        ...values,
        requestId: 'late-grant',
        expectedSourceSha256: run.sourceSha256,
        choices: {
          reason: 'Current grant required',
          upserts: [
            {
              collection: 'measurements',
              key: 'another',
              label: 'Another',
              value: { type: 'boolean', value: false },
              origin: { kind: 'local-actual' },
            },
          ],
        },
      },
      {
        beforeCommit: async () => {
          throw Error('Current grant revoked');
        },
      }
    );
    expect(deniedWrite.kind).toBe('refused');
    expect(readFileSync(run.path, 'utf8')).toBe(run.originalText);
    const changedValue = {
      ...values,
      expectedSourceSha256: run.sourceSha256,
      choices: {
        reason: 'Check original publication authority',
        upserts: [
          {
            collection: 'measurements',
            key: 'publication',
            label: 'Publication',
            value: { type: 'boolean', value: true },
            origin: { kind: 'local-actual' },
          },
        ],
      },
    };
    const refusedSource = await owner.recordRunValues(
      { ...changedValue, requestId: 'late-source' },
      {
        beforeCommit: async () => {
          writeFileSync(run.path, run.originalText.replace('Typed Run', 'External changed Run'));
        },
      }
    );
    expect(refusedSource.kind).toBe('refused');
    writeFileSync(run.path, run.originalText);
    const refusedAuthority = await owner.recordRunValues(
      { ...changedValue, requestId: 'late-authority' },
      {
        beforeCommit: async () => {
          db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
        },
      }
    );
    expect(refusedAuthority.kind).toBe('refused');
    db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
    expect(readFileSync(run.path, 'utf8')).toBe(run.originalText);
    expect(events()).toEqual(priorEvents);
    const completed = parseProtocolPackage(run.originalText).raw;
    completed.status = 'completed';
    completed.immutable = true;
    completed.completedAt = '2026-11-17T12:00:00.000Z';
    writeFileSync(run.path, canonicalProtocolJson(completed) + '\n');
    const completedSource = await owner.readPackage({ ...scope, entityId: run.entityId });
    await expect(
      owner.recordRunValues({
        ...changedValue,
        requestId: 'immutable-run',
        expectedSourceSha256: completedSource.sourceSha256,
      })
    ).rejects.toThrow('Completed');
    writeFileSync(run.path, run.originalText);
    const laterRun = parseProtocolPackage(run.originalText).raw;
    laterRun.title = 'Later Run title';
    const current = ready(
      await owner.savePackage({
        ...scope,
        requestId: 'later-run-title',
        entityId: run.entityId,
        expectedSourceSha256: run.sourceSha256,
        originalText: canonicalProtocolJson(laterRun) + '\n',
      })
    );
    expect(ready(await owner.recordRunValues(values)).originalText).toBe(published);
    expect(readFileSync(run.path, 'utf8')).toBe(current.originalText);
    renameSync(run.path, run.path + '.retained');
    expect(ready(await owner.recordRunValues(values)).originalText).toBe(published);
    expect(existsSync(run.path)).toBe(false);
    renameSync(run.path + '.retained', run.path);
    owner = make();
    expect((await owner.readPackage({ ...scope, entityId: run.entityId })).originalText).toBe(
      current.originalText
    );
    expect(physical()).toBe(beforePhysical);
    for (const [id, bytes] of oldReceipts) expect(readFileSync(receiptPath(id))).toEqual(bytes);
  } finally {
    await server.close();
    db.close();
  }
});
