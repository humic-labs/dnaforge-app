import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastaKindAuthority } from '../../../shared/fasta-kind';
import type { PlatformBridge } from '../../../platform/types';
import { FASTA_KIND_DECLARATION_EVENT } from '../../../shared/fasta-kind';
import { useWorkspaceStore, type WorkspaceFolder } from '../../../stores/workspaceStore';
import { AgentAuthorityError } from '../../../shared/agent-caller';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  platform: vi.fn(),
  caller: vi.fn(),
  confirm: vi.fn(),
  fixtureRoot: '',
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
  app: {
    getPath: (name: string) => {
      const root = state.fixtureRoot || tmpdir();
      return name === 'userData' ? join(root, 'app-profile') : root;
    },
    getVersion: () => 'test',
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../../platform', () => ({ platform: state.platform }));
vi.mock('../../../services/agent-caller', () => ({ resolveCurrentAgentCaller: state.caller }));
vi.mock('../../../components/confirm-dialog-store', () => ({ confirmDialog: state.confirm }));

import { createFileTestDb } from '../../../main/__tests__/test-db';
import { ensureSchema } from '../../../main/schema';
import { registerDatabaseHandlers } from '../../../main/ipc/database';
import { createLimsBridgeForDb } from '../../../main/__tests__/lims-bridge-for-db';
import {
  validateWorkspacePathInMain,
  writeWorkspaceTextFileAtomicInMain,
} from '../../../main/primer-artifact-files';
import { createClient } from '../../../shared/ipc-contract';
import { dbContract } from '../../../shared/ipc/db.contract';
import { callRendererTool, type RendererAuditRecord } from '../../agent-bridge/public/renderer-bridge';
import {
  ALLOWED_RENDERER_TOOLS,
  hostedToolNameForRenderer,
  rendererToolNameForHosted,
  resolveRendererToolAuthorization,
} from '../../agent-bridge/public/renderer-tools';
import rendererManifest from '../../../../../../packages/core/agent-tools/renderer-tool-manifest.json';
import { classifyFastaSchema, createClassifyFastaTool } from './fasta-kind';
import { execOpts } from './test-helpers';
import { createHostedPolicyTools } from '../orchestration/hosted-policy-tools';

describe('shared FASTA classification tools use native kind authority', () => {
  let fixture: ReturnType<typeof createFileTestDb>;
  let client: PlatformBridge['db'];
  let root: string;
  let source: string;
  let folders: WorkspaceFolder[];
  let nativeWrite: ReturnType<typeof vi.fn<typeof writeWorkspaceTextFileAtomicInMain>>;
  const snapshot = () =>
    ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events', 'workspaces'].map(
      (table) => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    );
  const call = async (name: string, args: unknown, capabilities: string[]) => {
    const records: RendererAuditRecord[] = [];
    const response = await callRendererTool(
      {
        tool_name: name,
        args,
        agent_identity: 'fasta-tool-test',
        action_id: crypto.randomUUID(),
      },
      {
        folders,
        currentWorkspaceId: root,
        boundWorkspaceId: root,
        agentCapabilities: capabilities,
        auditSink: {
          write: async (record) => {
            records.push(record);
            return `audit-${records.length}`;
          },
        },
      }
    );
    return { response, records };
  };
  const inspect = async () => {
    const { response } = await call('inspect_fasta_kind', { path: 'Project/legacy.faa' }, [
      'read-workspace',
    ]);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result).toMatchObject({ ok: true });
    return response.result as FastaKindAuthority;
  };

  beforeEach(async () => {
    fixture = createFileTestDb('fasta-agent-tools');
    state.fixtureRoot = fixture.tmpDir;
    mkdirSync(join(fixture.tmpDir, 'Project'));
    root = realpathSync(join(fixture.tmpDir, 'Project'));
    source = join(root, 'legacy.faa');
    writeFileSync(source, '>historical ambiguous FASTA\nACGTACGT\n');
    ensureSchema(fixture.db, fixture.dbPath);
    state.handlers.clear();
    state.sender = Object.assign(new EventEmitter(), { id: 366199 });
    registerDatabaseHandlers(() => fixture.db);
    client = {
      ...createClient(dbContract),
      select: async <T>(
        sql: string,
        params: Parameters<PlatformBridge['db']['select']>[1] = []
      ): Promise<T> => {
        const handler = state.handlers.get('db:select');
        if (!handler) throw new Error('Missing native SQL read handler');
        return (await handler({ sender: state.sender }, sql, params)) as T;
      },
    };
    nativeWrite = vi.fn(writeWorkspaceTextFileAtomicInMain);
    state.platform.mockReturnValue({
      db: client,
      lims: createLimsBridgeForDb(fixture.db),
      fs: {
        exists: async (path: string) => existsSync(path),
        readTextFile: async (path: string) => readFileSync(path, 'utf8'),
        readFile: async (path: string) => new Uint8Array(readFileSync(path)),
        mkdir: async (path: string) => mkdirSync(path, { recursive: true }),
        stat: async (path: string) => {
          const stat = statSync(path);
          return {
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            canonicalPath: realpathSync(path),
            mtime: stat.mtimeMs,
          };
        },
        validateWorkspacePath: validateWorkspacePathInMain,
        writeWorkspaceTextFileAtomic: nativeWrite,
        readDir: async (path: string) =>
          readdirSync(path, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isFile: entry.isFile(),
          })),
      },
    });
    folders = [{ name: 'Project', path: root, addedAt: 1 }];
    useWorkspaceStore.setState({ folders, activeWorkspaceFile: null });
    state.caller.mockReset().mockResolvedValue({
      agentIdentityId: 'direct-scientist',
      effectiveCapabilities: ['read-workspace', 'write-workspace', 'create-entity', 'edit-primers'],
    });
    state.confirm.mockReset().mockResolvedValue(false);
    const ownerId = await client.ensureWorkspaceOwner(root, undefined, { name: 'Project' });
    fixture.db
      .prepare(
        `INSERT INTO catalog_entities
         (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
         VALUES(?, 'sequence', 'Historical FASTA', ?, 'file', 'active', ?, ?, 1, 1)`
      )
      .run('legacy-fasta', `file://${source}`, ownerId, '{"moleculeType":"DNA"}');
    await client.bindCatalogEntityFile({
      entityId: 'legacy-fasta',
      workspaceRoot: root,
      path: source,
      fileKind: 'fasta',
      objectUuid: 'retained-fasta-object',
    });
  });

  afterEach(() => {
    state.sender?.removeAllListeners();
    state.platform.mockReset();
    useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
    fixture.cleanup();
  });

  it('reads ambiguous history without manufacturing declaration evidence, then classifies with ordinary write authority', async () => {
    const bytes = readFileSync(source);
    const before = snapshot();
    const authority = await inspect();
    expect(authority).toMatchObject({
      status: 'needs-classification',
      storedKind: 'sequence',
      readOnly: true,
      entityId: 'legacy-fasta',
      objectUuid: 'retained-fasta-object',
    });
    expect(authority.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot()).toEqual(before);
    const request = { path: source, kind: 'protein', expectedRevision: authority.revision };
    const denied = await call('classify_fasta', request, ['read-workspace']);
    expect(denied.response).toMatchObject({
      ok: false,
      error: { code: 'INSUFFICIENT_SCOPE' },
    });
    expect(denied.records.map((record) => record.status)).toEqual(['rejected']);
    expect(snapshot()).toEqual(before);
    const classified = await call('classify_fasta', request, ['write-workspace']);
    expect(classified.response).toMatchObject({
      ok: true,
      result: {
        ok: true,
        status: 'declared',
        kind: 'protein',
        entityId: authority.entityId,
        bindingId: authority.bindingId,
        objectUuid: authority.objectUuid,
      },
    });
    expect(classified.records.map((record) => record.status)).toEqual(['accepted', 'completed']);
    expect(readFileSync(source)).toEqual(bytes);
    expect(
      fixture.db.prepare('SELECT id,locator,workspace_id,created_at FROM catalog_entities').get()
    ).toMatchObject({
      id: 'legacy-fasta',
      locator: `file://${source}`,
      created_at: 1,
    });
    expect(
      fixture.db
        .prepare('SELECT entity_id,event_type FROM catalog_entity_events WHERE event_type=?')
        .all(FASTA_KIND_DECLARATION_EVENT)
    ).toEqual([{ entity_id: 'legacy-fasta', event_type: FASTA_KIND_DECLARATION_EVENT }]);
    expect(fixture.db.prepare('SELECT * FROM catalog_entity_events ORDER BY rowid').all()).toEqual(
      expect.arrayContaining(before[2])
    );
    expect(await inspect()).toMatchObject({ status: 'declared', kind: 'protein' });
  });

  it('Direct ordinary FASTA classification uses current grants without an extra confirmation', async () => {
    const tools = createHostedPolicyTools(folders, { turnId: 'direct-fasta' });
    const authority = (await tools.inspect_fasta_kind.execute!(
      { path: source },
      { toolCallId: 'direct-fasta-inspect', messages: [] }
    )) as FastaKindAuthority;
    const bytes = readFileSync(source);
    const classify = vi.spyOn(client, 'classifyFasta');
    const result = await tools.classify_fasta.execute!(
      { path: source, kind: 'protein', expectedRevision: authority.revision },
      { toolCallId: 'direct-fasta-classify', messages: [] }
    );
    expect(result).toMatchObject({ ok: true, status: 'declared', kind: 'protein' });
    expect(classify).toHaveBeenCalledOnce();
    expect(state.caller).toHaveBeenCalledTimes(2);
    expect(state.confirm).not.toHaveBeenCalled();
    expect(readFileSync(source)).toEqual(bytes);
    expect(
      fixture.db.prepare('SELECT type FROM catalog_entities WHERE id=?').get('legacy-fasta')
    ).toEqual({ type: 'protein' });
  });

  it('Direct ordinary primer authoring reaches its native file and SQLite owners without an extra confirmation', async () => {
    const tools = createHostedPolicyTools(folders, { turnId: 'direct-primer' });
    const result = await tools.create_primer.execute!(
      {
        name: 'Direct RNA oligo',
        artifactPath: 'primers/direct.primer.json',
        oligo: {
          vendor: 'idt',
          orderType: 'rna',
          notation: 'rArCrGrUrArCrGrUrArCrGrUrArCrGrUrArCrGrU',
        },
      },
      { toolCallId: 'direct-primer-create', messages: [] }
    );
    expect(result).toMatchObject({ changed: true, artifactRevision: 1, bindingCount: 0 });
    const artifact = JSON.parse(readFileSync(join(root, 'primers/direct.primer.json'), 'utf8'));
    expect(artifact.sequence.bases).toBe('ACGU'.repeat(5));
    expect(
      fixture.db.prepare('SELECT type FROM catalog_entities WHERE id=?').get(artifact.id)
    ).toEqual({ type: 'primer' });
    expect(nativeWrite).toHaveBeenCalledOnce();
    expect(state.caller).toHaveBeenCalledOnce();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it.each(['classify_fasta', 'create_primer'] as const)(
    'Direct %s refuses insufficient or missing current authority before native invocation',
    async (toolName) => {
      const authority = await inspect();
      const classify = vi.spyOn(client, 'classifyFasta');
      const tools = createHostedPolicyTools(folders, { turnId: `direct-denied-${toolName}` });
      const args =
        toolName === 'classify_fasta'
          ? { path: source, kind: 'protein', expectedRevision: authority.revision }
          : {
              name: 'Denied oligo',
              artifactPath: 'primers/denied.primer.json',
              oligo: {
                vendor: 'idt',
                orderType: 'rna',
                notation: 'rArCrGrUrArCrGrUrArCrGrUrArCrGrUrArCrGrU',
              },
            };
      const before = snapshot();
      state.caller.mockResolvedValueOnce({
        agentIdentityId: 'direct-scientist',
        effectiveCapabilities: ['read-workspace'],
      });
      await expect(
        tools[toolName].execute!(args, { toolCallId: 'scope-denied', messages: [] })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      state.caller.mockRejectedValueOnce(
        new AgentAuthorityError('GRANT_MISSING', 'No current grant.', false)
      );
      await expect(
        tools[toolName].execute!(args, { toolCallId: 'grant-missing', messages: [] })
      ).rejects.toMatchObject({ code: 'GRANT_MISSING' });
      expect(classify).not.toHaveBeenCalled();
      expect(nativeWrite).not.toHaveBeenCalled();
      expect(state.confirm).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
      expect(existsSync(join(root, 'primers/denied.primer.json'))).toBe(false);
    }
  );

  it.each(['source', 'binding'] as const)(
    'refuses an inspection revision after its %s changes',
    async (changed) => {
      const authority = await inspect();
      if (changed === 'source') writeFileSync(source, '>new source\nACGTACGTACGT\n');
      else
        fixture.db
          .prepare('UPDATE catalog_entity_files SET object_uuid=? WHERE id=?')
          .run('different-native-object', authority.bindingId);
      const before = snapshot();
      const bytes = readFileSync(source);
      const { response, records } = await call(
        'classify_fasta',
        { path: source, kind: 'protein', expectedRevision: authority.revision },
        ['write-workspace']
      );
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'FASTA_KIND_STALE', details: { stateChanged: false } },
      });
      expect(records.map((record) => record.status)).toEqual(['accepted', 'failed']);
      expect(snapshot()).toEqual(before);
      expect(readFileSync(source)).toEqual(bytes);
    }
  );

  it.each([
    ['reference', "access_mode='reference'"],
    ['archived', 'archived_at=2'],
    ['trashed', 'trashed_at=2'],
  ])('refuses classification after its owner becomes %s', async (name, stateSql) => {
    const authority = await inspect();
    fixture.db.prepare(`UPDATE workspaces SET ${stateSql}`).run();
    if (name === 'reference') expect(await inspect()).toMatchObject({ readOnly: true });
    const before = snapshot();
    const bytes = readFileSync(source);
    const { response } = await call(
      'classify_fasta',
      { path: source, kind: 'protein', expectedRevision: authority.revision },
      ['write-workspace']
    );
    expect(response).toMatchObject({
      ok: false,
      error: { details: { stateChanged: false } },
    });
    if (response.ok) throw new Error('Expected a native project write refusal');
    if (name === 'reference') expect(response.error.code).toBe('WORKSPACE_READ_ONLY');
    else expect(response.error.message).toMatch(/active|restore/i);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(source)).toEqual(bytes);
  });

  it('refuses paths outside the bound project before native classification', async () => {
    const classify = vi.spyOn(client, 'classifyFasta');
    const authority = await inspect();
    const before = snapshot();
    const { response } = await call(
      'classify_fasta',
      {
        path: join(realpathSync(fixture.tmpDir), 'another-project', 'legacy.faa'),
        kind: 'protein',
        expectedRevision: authority.revision,
      },
      ['write-workspace']
    );
    expect(response).toMatchObject({
      ok: false,
      error: { details: { stateChanged: false } },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('reports uncertain effects for an unrecognized transport failure after submission', async () => {
    const authority = await inspect();
    vi.spyOn(client, 'classifyFasta').mockRejectedValueOnce(new Error('IPC connection closed'));
    const tool = createClassifyFastaTool(folders);
    await expect(
      tool.execute!(
        {
          path: source,
          kind: 'protein',
          expectedRevision: authority.revision,
        },
        execOpts
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'FASTA_KIND_COMMAND_FAILED',
      stateChanged: 'unknown',
    });
  });

  it('stops before submission when already canceled', async () => {
    const authority = await inspect();
    const classify = vi.spyOn(client, 'classifyFasta');
    const abort = new AbortController();
    abort.abort();
    const tool = createClassifyFastaTool(folders);
    await expect(
      tool.execute!(
        { path: source, kind: 'protein', expectedRevision: authority.revision },
        { ...execOpts, abortSignal: abort.signal }
      )
    ).resolves.toMatchObject({ ok: false, code: 'CANCELED', stateChanged: false });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('FASTA kind tool publication', () => {
  it('publishes identical shared provider/MCP descriptions and top-level inputs with ordinary scopes', () => {
    for (const name of ['inspect_fasta_kind', 'classify_fasta'] as const) {
      const definition = ALLOWED_RENDERER_TOOLS[name];
      const entry = rendererManifest.tools.find((tool) => tool.name === name);
      expect(entry).toMatchObject({
        name,
        description: definition.description,
        required_capabilities: [
          name === 'inspect_fasta_kind' ? 'read-workspace' : 'write-workspace',
        ],
        exposure: { kind: 'shared' },
      });
      const fields =
        name === 'inspect_fasta_kind' ? ['path'] : ['path', 'kind', 'expectedRevision'];
      expect(Object.keys(entry!.inputSchema.properties).sort()).toEqual([...fields].sort());
      expect(entry!.inputSchema.required).toEqual(fields);
      expect(hostedToolNameForRenderer(name)).toBe(name);
      expect(rendererToolNameForHosted(name)).toBe(name);
      expect(resolveRendererToolAuthorization(name, {})).toEqual({
        requiredCapabilities: [
          name === 'inspect_fasta_kind' ? 'read-workspace' : 'write-workspace',
        ],
        requiresWorkspace: true,
      });
    }
    expect(
      classifyFastaSchema.safeParse({ path: 'Project/legacy.faa', kind: 'protein' }).success
    ).toBe(false);
  });
});
