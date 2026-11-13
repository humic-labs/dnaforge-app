// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ManagedDocumentSelection } from '@waypoint/domain-services';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import type { AgentProjectScope } from '../shared/agent-project-scope';
import type { TrustedManagedAnnotationAuthority } from '../shared/annotation-managed-operation-contract';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { NativeAnnotationDocumentOwner } from './native-annotation-document-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { registerWorkspaceFileInDb } from './catalog-entity-registration';
import { createEmptyManagedWorkspace } from './workspace-git/import';
import type { SidecarFetch } from './sidecar-request-auth';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => tmpdir(), getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

let db: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => db }));

const nativeIdentity = { ownerInstanceId: 'dna5047-native-owner', token: 'dna5047-native-token' };
const operationId = 'dna5047-retained-b-operation';
const actionId = 'dna5047-native-apply-action';
const requestSha256 = `sha256:${'c'.repeat(64)}`;
let directory: string;
let rootA: string;
let rootB: string;
let sourcePath: string;
let original: string;
let target: { operationId: string; targetDocumentId: string };
let retained: TrustedManagedAnnotationAuthority;
let selection: ManagedDocumentSelection;
let owner: NativeAnnotationDocumentOwner;
let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>>;
let workspaces: NativeDocumentWorkspaces;
let prepareCalls: number;
let intents: number;

function receipt(outcome: string, details: Record<string, unknown>) {
  return {
    id: actionId,
    operation_id: operationId,
    action: 'apply_to_document',
    outcome,
    details_json: {
      request_sha256: requestSha256,
      target_document_id: target.targetDocumentId,
      ...details,
    },
  };
}

const retainedResultClient: SidecarFetch = async (path, options) => {
  const command = String(path).split('/').at(-1);
  if (command === 'authority') return Response.json(retained);
  const body = JSON.parse(String(options?.body));
  if (command === 'intent') {
    intents++;
    return Response.json({
      status: 'permitted',
      record: receipt('document_writing', { write_intent: body.intent }),
    });
  }
  if (command === 'settlement') {
    return Response.json({
      status: 'recorded',
      record: receipt(`document_${body.settlement.status.replaceAll('-', '_')}`, {
        settlement: body.settlement,
      }),
    });
  }
  throw new Error('Unexpected retained annotation journal request.');
};

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dna5047-native-scope-')));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  const managedRootDir = join(directory, 'managed-workspaces');
  rootA = (await createEmptyManagedWorkspace('Project A', { db, managedRootDir })).repoPath;
  rootB = (await createEmptyManagedWorkspace('Project B', { db, managedRootDir })).repoPath;
  await writeFile(join(rootA, 'a-only.txt'), 'Project A remains unchanged.');
  sourcePath = join(rootB, 'target-b.gb');
  original = serializeSequenceForInPlaceSave(
    {
      id: 'initial-b',
      name: 'B sequence',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    },
    sourcePath
  );
  await writeFile(sourcePath, original);
  const document = registerWorkspaceFileInDb(db, {
    path: sourcePath,
    workspaceRoot: rootB,
    entityType: 'sequence',
    fileKind: 'genbank',
  });
  target = { operationId, targetDocumentId: document.id };
  for (const args of [
    ['config', 'user.name', 'DNAForge fixture'],
    ['config', 'user.email', 'fixture@users.noreply.github.com'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', 'target-b.gb'],
    ['commit', '--quiet', '-m', 'B original sequence'],
  ])
    execFileSync('git', ['-C', rootB, ...args]);
  const registered = createRegisteredProjectAuthority({
    db: () => db,
    managedRootDir: () => managedRootDir,
  });
  workspaces = new NativeDocumentWorkspaces({ authority: registered });
  retained = {
    schema: 'dnaforge.managed-annotation-authority.v1',
    operation: {
      id: operationId,
      kind: 'annotation',
      state: 'succeeded',
      result_status: 'available',
      version: 3,
      subject: {
        scope_id: 'dna5047-runtime',
        subject_id: target.targetDocumentId,
        input_revision: await annotationInputRevision({ sequence: 'ATGC', linear: true }),
      },
    },
    resultSha256: `sha256:${'a'.repeat(64)}`,
    result: {
      sequence_length: 4,
      features: [
        {
          name: 'Retained B candidate',
          type: 'misc_feature',
          start: 1,
          end: 4,
          strand: 1,
          identity: 100,
          coverage: 100,
          fragment: false,
          ref_start: 1,
          ref_end: 4,
          ref_length: 4,
          db_source: 'nucleotide',
        },
      ],
    },
  };
  prepareCalls = 0;
  intents = 0;
  owner = new NativeAnnotationDocumentOwner({
    nativeOwnerInstanceId: nativeIdentity.ownerInstanceId,
    db: () => db,
    workspaceRoots: () => workspaces.roots(),
    fetch: retainedResultClient,
    prepare: async (_action, document) => {
      prepareCalls++;
      const assertCurrent = workspaces.capture(document.workspaceRoot);
      return { assertCurrent, finish: async () => 'not-required', abort() {} };
    },
  });
  const inspection = await owner.inspect(target, retained);
  selection = {
    ...target,
    expectedOperationVersion: inspection.operationVersion,
    expectedResultSha256: inspection.resultSha256,
    expectedTargetDocumentRevision: inspection.targetDocumentRevision,
    selectedCandidateIds: inspection.candidates.map((candidate) => candidate.id),
  };
  server = await startNativeDocumentCommandServer({
    owner,
    projectAuthority: registered,
    getAuthority: () => nativeIdentity,
  });
});

afterEach(async () => {
  await server?.close();
  await owner?.close();
  db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function call(
  command: 'annotation.inspect' | 'annotation.apply',
  projectScope?: AgentProjectScope
) {
  const response = await fetch(`${server.url}/internal/native-documents/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DNAForge-Native-Document-Authority': nativeIdentity.token,
    },
    body: JSON.stringify({
      ownerInstanceId: nativeIdentity.ownerInstanceId,
      ...(projectScope ? { projectScope } : {}),
      command,
      ...(command === 'annotation.inspect'
        ? { target, authority: retained }
        : { request: { actionId, requestSha256, selection } }),
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function unchanged() {
  return {
    b: (await readFile(sourcePath, 'utf8')) === original,
    a: (await readFile(join(rootA, 'a-only.txt'), 'utf8')) === 'Project A remains unchanged.',
  };
}

describe(' native annotation project scopes', () => {
  it.each(['annotation.inspect', 'annotation.apply'] as const)(
    'explicit A denies a retained B target through %s without B data or mutation',
    async (command) => {
      const { body } = await call(command, { kind: 'project-roots', roots: [rootA] });
      const denied =
        body.ok === false || body.result?.ok === false || body.result?.status === 'blocked';
      expect({
        denied,
        unchanged: await unchanged(),
        prepareCalls,
        intents,
        leakedTarget: JSON.stringify(body).includes(target.targetDocumentId),
        leakedRoot: JSON.stringify(body).includes(rootB),
      }).toEqual({
        denied: true,
        unchanged: { a: true, b: true },
        prepareCalls: 0,
        intents: 0,
        leakedTarget: false,
        leakedRoot: false,
      });
    }
  );

  it.each(['project-b', 'app-following'] as const)(
    'authorized %s inspects hidden B and returns its exact identity',
    async (scope) => {
      const projectScope: AgentProjectScope =
        scope === 'project-b'
          ? { kind: 'project-roots', roots: [rootB] }
          : { kind: 'app-following' };
      const response = await call('annotation.inspect', projectScope);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        result: {
          ...target,
          applicable: true,
          candidates: [{ id: `${operationId}:0`, feature: { name: 'Retained B candidate' } }],
        },
      });
      expect(await unchanged()).toEqual({ a: true, b: true });
      expect(workspaces.observedRoots()).toEqual([]);
      expect({ prepareCalls, intents }).toEqual({ prepareCalls: 0, intents: 0 });
    }
  );

  it.each(['project-b', 'app-following'] as const)(
    'authorized %s applies the retained B candidate to real bytes while B stays hidden',
    async (scope) => {
      const projectScope: AgentProjectScope =
        scope === 'project-b'
          ? { kind: 'project-roots', roots: [rootB] }
          : { kind: 'app-following' };
      const response = await call('annotation.apply', projectScope);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        result: { status: 'saved', checkpoint: { status: 'committed' } },
      });
      const saved = parseSequenceFileAsDocument(
        await readFile(sourcePath, 'utf8'),
        sourcePath
      ).sequence;
      expect(
        saved.annotations.some((annotation) => annotation.name === 'Retained B candidate')
      ).toBe(true);
      expect(await unchanged()).toEqual({ a: true, b: false });
      expect(workspaces.observedRoots()).toEqual([]);
      expect({ prepareCalls, intents }).toEqual({ prepareCalls: 1, intents: 1 });
    }
  );

  it.each(['annotation.inspect', 'annotation.apply'] as const)(
    'missing projectScope refuses %s before native access or mutation',
    async (command) => {
      const inspect = vi.spyOn(owner, 'inspect');
      const apply = vi.spyOn(owner, 'apply');
      const { body } = await call(command);
      const observed = {
        ok: body.ok,
        hasResult: Object.hasOwn(body, 'result'),
        unchanged: await unchanged(),
        inspectCalls: inspect.mock.calls.length,
        applyCalls: apply.mock.calls.length,
        prepareCalls,
        intents,
      };
      console.info(' missing-scope observation', JSON.stringify({ command, ...observed }));
      expect(observed).toEqual({
        ok: false,
        hasResult: false,
        unchanged: { a: true, b: true },
        inspectCalls: 0,
        applyCalls: 0,
        prepareCalls: 0,
        intents: 0,
      });
    }
  );

  it('app-following cannot apply to a registered readonly B project', async () => {
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(rootB);
    const { body } = await call('annotation.apply', { kind: 'app-following' });
    const denied =
      body.ok === false || body.result?.ok === false || body.result?.status === 'blocked';
    expect({ denied, unchanged: await unchanged(), prepareCalls, intents }).toEqual({
      denied: true,
      unchanged: { a: true, b: true },
      prepareCalls: 0,
      intents: 0,
    });
  });
});
