import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';
import { createTestDb } from '../../main/__tests__/test-db';
import { createCatalogRepository } from '../../db/catalog-repository';
import {
  runTrackedWorkspaceReconcile,
  waitForWorkspaceReconcileIdle,
} from '../../services/workspace-reconcile-lifecycle';
import { createBenchlingMigrationWizardBridge } from './platform-adapter';
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: vi.fn() }));
const appSourcePath = resolve(__dirname, '../../App.tsx');
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function run(state: BenchlingMigrationRunView['state'] = 'draft'): BenchlingMigrationRunView {
  return {
    version: 1,
    id: 'run-1',
    workspaceId: 'workspace-1',
    displayName: 'Local Benchling import',
    scope: {
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
      source: {
        id: 'local-export-pending-test',
        url: 'urn:dnaforge:benchling-local-export:pending:test',
        objectType: 'notebook',
      },
    },
    binding: null,
    state,
    resumeState: null,
    attempt: 0,
    converterVersions: {},
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    startedAt: null,
    unlockedAt: null,
    lastError: null,
    recoveryAction: null,
    localBundleState: state === 'draft' ? 'copying' : 'ready',
  };
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  assert(resolve);
  return { promise, resolve };
}
function callAsync(subject: unknown, name: string, args: unknown[]): Promise<unknown> {
  assert(subject !== null && typeof subject === 'object');
  const method = Reflect.get(subject, name);
  assert(typeof method === 'function');
  const result: unknown = Reflect.apply(method, subject, args);
  assert(result instanceof Promise);
  return result;
}
function fixture() {
  const db = createTestDb();
  cleanups.push(() => db.close());
  db.exec('CREATE TABLE workspaces(id INTEGER PRIMARY KEY,path TEXT)');
  const root = '/contract/' + randomUUID(),
    other = root + '-other';
  db.prepare('INSERT INTO workspaces(id,path) VALUES(28,?),(29,?)').run(root, other);
  const select = vi.fn(async (sql: string, args: unknown[]) => db.prepare(sql).all(...args));
  const unavailable = () => {
    throw Error('Unexpected catalog write/stat/mutation in readonly target lookup');
  };
  const repository = Reflect.apply(createCatalogRepository, undefined, [
    {
      db: () => ({ select, execute: unavailable }),
      stat: unavailable,
      isHosted: () => false,
      withMutation: unavailable,
    },
  ]);
  const getWorkspaceRootById = vi.fn((id: number) =>
    Reflect.apply(repository.getWorkspaceRootById, repository, [id])
  );
  const wait = vi.fn((path: string) => waitForWorkspaceReconcileIdle(path));
  const native = vi.fn(async (_request: unknown) => ({ run: run('parsing') }));
  const platform = { importLocalBundle: native };
  const readiness = { getWorkspaceRootById, waitForWorkspaceReconcileIdle: wait };
  const bridge = Reflect.apply(createBenchlingMigrationWizardBridge, undefined, [
    platform,
    { existingWorkspaceReadiness: readiness },
  ]);
  const selection = {
    sourcePath: '/public/fixture/export.zip',
    archiveName: 'export.zip',
    archiveObjectCount: 1,
    candidates: [],
  };
  const append = (subject: unknown = bridge) =>
    callAsync(subject, 'importPreparedLocalBundle', [
      selection,
      { kind: 'existing_workspace', workspaceDbId: 28 },
    ]);
  return {
    db,
    root,
    other,
    select,
    getWorkspaceRootById,
    wait,
    native,
    platform,
    bridge,
    selection,
    append,
    realRoot: repository.getWorkspaceRootById,
  };
}
function observe(promise: Promise<unknown>) {
  const state = { kind: 'pending' };
  void promise.then(
    () => (state.kind = 'resolved'),
    () => (state.kind = 'rejected')
  );
  return state;
}
async function targetPending(f: ReturnType<typeof fixture>, state: { kind: string }) {
  await vi.waitFor(() => expect(f.getWorkspaceRootById).toHaveBeenCalledWith(28));
  await vi.waitFor(() => assert(f.wait.mock.calls.some(([root]) => root === f.root)));
  expect(state.kind).toBe('pending');
  expect(f.native).not.toHaveBeenCalled();
  expect(f.wait).toHaveBeenCalledWith(f.root);
}
it('accepted adapter append waits for selected native catalog root reconciliation before unchanged native payload', async () => {
  const f = fixture(),
    gate = deferred();
  const reconcile = runTrackedWorkspaceReconcile(f.root, () => gate.promise);
  const promise = f.append();
  const state = observe(promise);
  try {
    await targetPending(f, state);
    expect(f.select.mock.calls.every(([, args]) => args[0] === 28)).toBe(true);
    gate.resolve();
    await reconcile;
    await promise;
    expect(f.getWorkspaceRootById).toHaveBeenCalledTimes(2);
    expect(f.native).toHaveBeenCalledExactlyOnceWith({
      sourcePath: f.selection.sourcePath,
      workspaceDbId: 28,
    });
  } finally {
    gate.resolve();
    await reconcile;
    await promise.catch(() => undefined);
  }
});
it('unrelated tracked workspace does not delay selected idle destination', async () => {
  const f = fixture(),
    gate = deferred();
  const reconcile = runTrackedWorkspaceReconcile(f.other, () => gate.promise);
  let unrelatedSettled = false;
  void reconcile.then(() => {
    unrelatedSettled = true;
  });
  try {
    await f.append();
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.wait).toHaveBeenCalledExactlyOnceWith(f.root);
    expect(unrelatedSettled).toBe(false);
  } finally {
    gate.resolve();
    await reconcile;
  }
});
it('selected target barrier includes another tracked operation added while the first remains pending', async () => {
  const f = fixture(),
    first = deferred(),
    second = deferred();
  const a = runTrackedWorkspaceReconcile(f.root, () => first.promise);
  const promise = f.append();
  const state = observe(promise);
  let b: Promise<void> | undefined;
  try {
    await targetPending(f, state);
    b = runTrackedWorkspaceReconcile(f.root, () => second.promise);
    first.resolve();
    await a;
    await Promise.resolve();
    await Promise.resolve();
    expect(state.kind).toBe('pending');
    expect(f.native).not.toHaveBeenCalled();
    second.resolve();
    await b;
    await promise;
    expect(f.native).toHaveBeenCalledOnce();
  } finally {
    first.resolve();
    second.resolve();
    await a;
    await b;
    await promise.catch(() => undefined);
  }
});
it.each(['changed', 'missing'] as const)(
  'selected native workspace binding %s during reconciliation refuses dispatch instead of retargeting',
  async (kind) => {
    const f = fixture(),
      gate = deferred();
    const reconcile = runTrackedWorkspaceReconcile(f.root, () => gate.promise);
    const promise = f.append();
    const state = observe(promise);
    try {
      await targetPending(f, state);
      if (kind === 'changed') f.db.prepare('UPDATE workspaces SET path=? WHERE id=28').run(f.other);
      else f.db.prepare('DELETE FROM workspaces WHERE id=28').run();
      gate.resolve();
      await reconcile;
      await expect(promise).rejects.toThrow();
      expect(f.native).not.toHaveBeenCalled();
      expect(f.wait).toHaveBeenCalledExactlyOnceWith(f.root);
    } finally {
      gate.resolve();
      await reconcile;
      await promise.catch(() => undefined);
    }
  }
);
it('missing initial native catalog mapping refuses dispatch without global waiting or fallback', async () => {
  const f = fixture();
  f.db.prepare('DELETE FROM workspaces WHERE id=28').run();
  await expect(f.append()).rejects.toThrow();
  expect(f.wait).not.toHaveBeenCalled();
  expect(f.native).not.toHaveBeenCalled();
});
it('native catalog lookup failure refuses dispatch rather than treating unavailable authority as idle', async () => {
  const f = fixture();
  f.db.exec('DROP TABLE workspaces');
  await expect(f.append()).rejects.toThrow();
  expect(f.native).not.toHaveBeenCalled();
  expect(f.wait).not.toHaveBeenCalled();
});
it('new workspace intake bypasses existing-root resolution and tracked reconciliation', async () => {
  const f = fixture(),
    gate = deferred();
  const reconcile = runTrackedWorkspaceReconcile(f.root, () => gate.promise);
  try {
    await Reflect.apply(f.bridge.importPreparedLocalBundle, f.bridge, [
      f.selection,
      { kind: 'new_workspace', workspaceName: 'Public fixture' },
    ]);
    expect(f.getWorkspaceRootById).not.toHaveBeenCalled();
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.native).toHaveBeenCalledExactlyOnceWith({
      sourcePath: f.selection.sourcePath,
      workspaceName: 'Public fixture',
    });
  } finally {
    gate.resolve();
    await reconcile;
  }
});
it('missing explicit readiness dependency refuses existing append and never falls back to immediate native dispatch', async () => {
  const f = fixture();
  const bridge = Reflect.apply(createBenchlingMigrationWizardBridge, undefined, [f.platform, {}]);
  await expect(f.append(bridge)).rejects.toThrow();
  expect(f.native).not.toHaveBeenCalled();
});
it('native render-validation idle wait can settle because the adapter never tracks the import itself as reconciliation', async () => {
  const f = fixture(),
    gate = deferred();
  const reconcile = runTrackedWorkspaceReconcile(f.root, () => gate.promise);
  f.native.mockImplementation(async () => {
    await waitForWorkspaceReconcileIdle(f.root);
    return { run: run('parsing') };
  });
  const promise = f.append();
  const state = observe(promise);
  try {
    await targetPending(f, state);
    gate.resolve();
    await reconcile;
    await vi.waitFor(() => expect(state.kind).toBe('resolved'), { timeout: 1500, interval: 5 });
    expect(f.native).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await reconcile;
  }
});
it('actual App producer reaches the desktop factory with canonical append readiness owners', async () => {
  const feature = './features/benchling-migration';
  const factoryName = 'createDesktopBenchlingMigrationWizardBridge';
  const factoryModule = './desktop-platform-adapter';
  const appDirectory = dirname(appSourcePath);
  function readSource(path: string, kind = ts.ScriptKind.TS) {
    return ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      kind
    );
  }
  function namedImports(source: ts.SourceFile) {
    const imports = new Map<string, string>();
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      )
        for (const specifier of statement.importClause.namedBindings.elements)
          if (!specifier.isTypeOnly && !specifier.propertyName)
            imports.set(specifier.name.text, statement.moduleSpecifier.text);
    }
    return imports;
  }
  const app = readSource(appSourcePath, ts.ScriptKind.TSX);
  assert.equal(namedImports(app).get(factoryName), feature);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === factoryName
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert(call);

  const featureDirectory = resolve(appDirectory, feature);
  const barrel = readSource(resolve(featureDirectory, 'index.ts'));
  assert(
    barrel.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === factoryModule &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (specifier) =>
            !specifier.isTypeOnly && !specifier.propertyName && specifier.name.text === factoryName
        )
    )
  );
  const owner = readSource(resolve(featureDirectory, factoryModule + '.ts'));
  const imports = namedImports(owner);
  expect(imports.get('getWorkspaceRootById')).toBe('../../db/workspace-catalog');
  expect(imports.get('waitForWorkspaceReconcileIdle')).toBe(
    '../../services/workspace-reconcile-lifecycle'
  );
  assert.equal(imports.get('createBenchlingMigrationWizardBridge'), './platform-adapter');
  const factory = owner.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName
  );
  assert(factory?.body);
  assert(factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const factorySource = ts.transpileModule(
    'function ' +
      factoryName +
      '(' +
      factory.parameters.map((p) => p.getText(owner)).join(',') +
      ') ' +
      factory.body.getText(owner),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;

  const f = fixture();
  const appWait = vi.fn((root: string) => waitForWorkspaceReconcileIdle(root));
  const produce = new Function(
    'createBenchlingMigrationWizardBridge',
    'getWorkspaceRootById',
    'waitForWorkspaceReconcileIdle',
    'benchlingMigrationPlatform',
    'benchlingMigrationDialogOpen',
    factorySource + '\nreturn (' + call.getText(app) + ')'
  );
  const bridge = produce(
    createBenchlingMigrationWizardBridge,
    f.realRoot,
    appWait,
    f.platform,
    vi.fn()
  );
  const gate = deferred();
  const reconcile = runTrackedWorkspaceReconcile(f.root, () => gate.promise);
  const promise = f.append(bridge);
  const state = observe(promise);
  try {
    await vi.waitFor(() => expect(f.select).toHaveBeenCalled());
    await vi.waitFor(() => assert(appWait.mock.calls.some(([root]) => root === f.root)));
    expect(state.kind).toBe('pending');
    expect(f.native).not.toHaveBeenCalled();
    gate.resolve();
    await reconcile;
    await promise;
    expect(f.native).toHaveBeenCalledExactlyOnceWith({
      sourcePath: f.selection.sourcePath,
      workspaceDbId: 28,
    });
  } finally {
    gate.resolve();
    await reconcile;
    await promise.catch(() => undefined);
  }
});
