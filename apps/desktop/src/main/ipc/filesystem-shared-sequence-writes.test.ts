import { EventEmitter } from 'node:events';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  marker: '',
  publications: vi.fn(),
  beforeTextPublication: vi.fn(),
  revokeOnCrossDeviceRename: false,
  crossDeviceSource: '',
  partialRemoval: '',
  beforePromotion: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: vi.fn(actual.cp),
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0]);
      if (
        host.partialRemoval &&
        (target === host.partialRemoval ||
          (basename(target) === 'original' &&
            dirname(dirname(target)) === dirname(host.partialRemoval)))
      ) {
        await actual.rm(join(target, 'sequence.gb'));
        throw Object.assign(new Error('injected partial source removal'), { code: 'EIO' });
      }
      return actual.rm(...args);
    },
  };
});
vi.mock('../exclusive-path-promotion', async (original) => {
  const actual = await original<typeof import('../exclusive-path-promotion')>();
  return {
    ...actual,
    promotePathExclusively(source: string, destination: string) {
      host.beforePromotion(source, destination);
      if (host.revokeOnCrossDeviceRename) {
        host.db?.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
        throw Object.assign(new Error('Cross-device move'), { code: 'EXDEV' });
      }
      if (source === host.crossDeviceSource && basename(destination) !== 'original')
        throw Object.assign(new Error('Cross-device move'), { code: 'EXDEV' });
      return actual.promotePathExclusively(source, destination);
    },
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    app: { getPath: () => '/tmp', getVersion: () => 'test', on: vi.fn() },
    BrowserWindow: class extends EventEmitter {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    dialog: { showErrorBox: vi.fn() },
  };
});
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./database', () => ({ getDb: () => host.db }));
vi.mock('./path-allowlist', () => ({
  assertSafePath: async (path: string) => path,
  withSafeWritablePath: async (path: string, operation: (path: string) => Promise<unknown>) =>
    operation(path),
  withSafeWritablePaths: async (
    requests: Array<{ path: string }>,
    operation: (paths: string[]) => Promise<unknown>
  ) => operation(requests.map(({ path }) => path)),
}));
vi.mock('../primer-artifact-files', async (original) => {
  const actual = await original<typeof import('../primer-artifact-files')>();
  return {
    ...actual,
    writeWorkspaceTextFileAtomicInMain: (
      input: Parameters<typeof actual.writeWorkspaceTextFileAtomicInMain>[0],
      fsOps: Parameters<typeof actual.writeWorkspaceTextFileAtomicInMain>[1]
    ) =>
      actual.writeWorkspaceTextFileAtomicInMain(input, {
        ...fsOps,
        beforePublish: (stagedPath) => {
          host.beforeTextPublication();
          fsOps?.beforePublish?.(stagedPath);
        },
      }),
  };
});
vi.mock('../sequence-package-revision-publication', async (original) => {
  const actual = await original<typeof import('../sequence-package-revision-publication')>();
  const publish = async () => {
    host.publications();
    await writeFile(host.marker, 'published');
    return { revisionId: 'published', alreadyPublished: false, snapshotPaths: [], assetPaths: [] };
  };
  return {
    ...actual,
    publishSequenceMetadataRevisionInMain: publish,
    publishAcceptedAssemblyRevisionInMain: publish,
    publishSequenceUserAttachmentMutationInMain: publish,
    applySequenceRestoreInMain: publish,
    previewSequenceRestoreInMain: async () => ({ changedItems: [], blockers: [], warnings: [] }),
  };
});

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { configureSavedFileBlobRoot } from '../saved-file-sources';
import { nativeDocuments } from '../features/native-documents';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { registerFilesystemHandlers } from './filesystem';

let root: string;
let packageRoot: string;
let nativeProfile: string;
const sender = Object.assign(new BrowserWindow(), {
  webContents: Object.assign(new EventEmitter(), {
    id: 962,
    mainFrame: { url: 'file:///fixture/index.html' },
    getURL: () => 'file:///fixture/index.html',
    isDestroyed: () => false,
    send: vi.fn(),
  }),
}).webContents;
const event = () =>
  ({
    sender,
    senderFrame: sender.mainFrame,
    type: 'frame',
    frameId: 0,
    processId: 0,
    preventDefault: vi.fn(),
    defaultPrevented: false,
  }) satisfies IpcMainInvokeEvent;
const kinds = ['metadata', 'assembly', 'attachment', 'restore'] as const;
type Kind = (typeof kinds)[number];
const channels: Record<Kind, string> = {
  metadata: 'fs:publishSequenceMetadataRevision',
  assembly: 'fs:publishAcceptedAssemblyRevision',
  attachment: 'fs:publishSequenceUserAttachmentMutation',
  restore: 'fs:applySequenceRestore',
};

beforeAll(async () => {
  nativeProfile = await realpath(await mkdtemp(join(tmpdir(), 'shared-sequence-native-profile-')));
  nativeDocuments.bindProfile(nativeProfile);
});

afterAll(async () => {
  await nativeDocuments.closeServerAndRecovery();
  await rm(nativeProfile, { recursive: true, force: true });
});

beforeEach(async () => {
  host.revokeOnCrossDeviceRename = false;
  host.crossDeviceSource = '';
  host.partialRemoval = '';
  host.beforePromotion.mockReset();
  root = await realpath(await mkdtemp(join(tmpdir(), 'shared-sequence-publication-')));
  packageRoot = join(root, 'package');
  await mkdir(packageRoot);
  host.marker = join(packageRoot, 'publication.marker');
  await writeFile(host.marker, 'original');
  const source = join(packageRoot, 'sequence.gb');
  await writeFile(source, 'sequence bytes');
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES (7,'Owner',?,'project',1)"
    )
    .run(root);
  host.db
    .prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES ('document','sequence','Sequence',?,'file',7,1,1)"
    )
    .run(source);
  host.db
    .prepare(
      "INSERT INTO catalog_entity_files(entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES ('document',7,?,'genbank','current',1,1)"
    )
    .run(source);
  host.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,access_source,shared_with_others,created_at,updated_at)
    VALUES (7,'project','account','remote',0,'viewer','direct',1,1,1)`
    )
    .run();
  host.publications.mockClear();
  host.beforeTextPublication.mockReset();
  vi.mocked(ipcMain.handle).mockClear();
  registerFilesystemHandlers();
});

afterEach(async () => {
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

it('packages loose sequence bytes and preserves the published product when required conversion skips it on retry', async () => {
  host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
  configureSavedFileBlobRoot(host.db!, join(nativeProfile, 'retained'));
  const path = join(root, 'loose.gb');
  const bytes = 'LOCUS       Preview  4 bp    DNA     linear SYN\nORIGIN\n        1 acgt\n//\n';
  await writeFile(path, bytes);
  const packageFile = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:packageSequenceFile')!;
  const result = await packageFile(event(), path, { requireConverted: true });
  expect(result.converted).toBe(true);
  expect(await readFile(result.productPath, 'utf8')).toBe(bytes);
  const saved = host
    .db!.prepare(
      "SELECT entity_id FROM retained_file_source_revisions WHERE workspace_id=7 AND status='committed'"
    )
    .all();
  expect(saved).toHaveLength(1);
  await expect(
    packageFile(event(), result.productPath, { requireConverted: true })
  ).rejects.toThrow('SEQUENCE_PACKAGE_REQUIRED');
  expect(await readFile(result.productPath, 'utf8')).toBe(bytes);
  expect(
    host
      .db!.prepare(
        "SELECT DISTINCT entity_id FROM retained_file_source_revisions WHERE workspace_id=7 AND status='committed'"
      )
      .all()
  ).toEqual(saved);
});

it.each(['registered', 'unregistered'] as const)(
  'preserves a pre-existing %s input when required sequence conversion skips it',
  async (kind) => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const path = kind === 'registered' ? join(packageRoot, 'sequence.gb') : join(root, 'data.txt');
    const bytes = Buffer.from([0x61, 0x62, 0x0d, 0x0a]);
    await writeFile(path, bytes);
    const packageFile = new Map(vi.mocked(ipcMain.handle).mock.calls).get(
      'fs:packageSequenceFile'
    )!;
    expect(await packageFile(event(), path)).toMatchObject({
      productPath: path,
      converted: false,
      packageRoots: [],
    });
    await expect(packageFile(event(), path, { requireConverted: true })).rejects.toThrow(
      'SEQUENCE_PACKAGE_REQUIRED'
    );
    expect(await readFile(path)).toEqual(bytes);
    expect(
      host.db!.prepare("SELECT path FROM catalog_entity_files WHERE entity_id='document'").get()
    ).toEqual({ path: join(packageRoot, 'sequence.gb') });
  }
);

function invoke(kind: Kind) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channels[kind]);
  if (!handler) throw new Error(`Missing actual native handler ${channels[kind]}`);
  const input =
    kind === 'metadata'
      ? { document: { packageId: 'document', packageRoot }, operationId: 'operation' }
      : {
          workspaceRoot: root,
          packageRoot,
          packageId: 'document',
          operationId: 'operation',
          mutation: {},
        };
  return handler(event(), input);
}

describe('shared role admission at actual sequence publication IPC owners', () => {
  it('uses the stored shared role when the registered workspace path is an alias', async () => {
    const alias = join(root, 'owner-alias');
    await symlink(root, alias);
    host.db!.prepare('UPDATE workspaces SET path=? WHERE id=7').run(alias);
    await expect(invoke('metadata')).rejects.toThrow(/shared project is view only/i);
    expect(host.publications).not.toHaveBeenCalled();
  });

  it('refuses ambiguous active ownership of the same physical workspace', async () => {
    const alias = join(root, 'second-owner');
    await symlink(root, alias);
    host
      .db!.prepare("INSERT INTO workspaces(name,path,created_at) VALUES ('Other',?,1)")
      .run(alias);
    await expect(invoke('restore')).rejects.toThrow(/one active writable owning project/i);
    expect(host.publications).not.toHaveBeenCalled();
  });

  it.each(['assembly', 'restore'] as const)(
    'refuses file-first viewer %s writes without a catalog projection',
    async (kind) => {
      host.db!.prepare('DELETE FROM catalog_entity_files').run();
      await expect(invoke(kind)).rejects.toThrow(/shared project is view only/i);
      expect(host.publications).not.toHaveBeenCalled();
      expect(await readFile(host.marker, 'utf8')).toBe('original');
    }
  );
  it.each(['assembly', 'restore'] as const)(
    'keeps file-first %s recovery available before catalog reconstruction',
    async (kind) => {
      host.db!.prepare('DELETE FROM catalog_entity_files').run();
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      await invoke(kind);
      expect(host.publications).toHaveBeenCalledTimes(1);
      expect(await readFile(host.marker, 'utf8')).toBe('published');
    }
  );
  it('keeps restore preview readable for a viewer without publishing', async () => {
    const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:previewSequenceRestore');
    if (!handler) throw new Error('Missing actual restore preview handler');
    await expect(
      handler(event(), {
        workspaceRoot: root,
        packageRoot,
        packageId: 'document',
        selections: [],
      })
    ).resolves.toMatchObject({ changedItems: [] });
    expect(host.publications).not.toHaveBeenCalled();
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
  it.each(kinds)('refuses viewer %s publication before publisher writes', async (kind) => {
    const before = host.db!.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
    await expect(invoke(kind)).rejects.toThrow(/shared project is view only/i);
    expect(host.publications).not.toHaveBeenCalled();
    expect(await readFile(host.marker, 'utf8')).toBe('original');
    expect(host.db!.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(before);
  });

  it.each(kinds)('permits offline editor %s publication after promotion', async (kind) => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    await invoke(kind);
    expect(host.publications).toHaveBeenCalledTimes(1);
    expect(await readFile(host.marker, 'utf8')).toBe('published');
  });
});

const genericKinds = ['writeTextFile', 'writeTextFileAtomic', 'mkdir', 'rename', 'move'] as const;
function invokeGeneric(kind: (typeof genericKinds)[number], path = host.marker) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(`fs:${kind}`);
  if (!handler) throw new Error(`Missing actual native handler fs:${kind}`);
  switch (kind) {
    case 'writeTextFile':
      return handler(event(), path, 'changed');
    case 'writeTextFileAtomic':
      return handler(event(), { path, content: 'changed' });
    case 'mkdir':
      return handler(event(), join(root, 'created-folder'));
    case 'rename':
      return handler(event(), path, join(root, 'renamed.marker'));
    case 'move':
      return handler(event(), path, root);
  }
}

describe('shared role admission at generic filesystem IPC owners', () => {
  it.each(genericKinds)('refuses viewer %s before changing real files', async (kind) => {
    await expect(invokeGeneric(kind)).rejects.toThrow(/shared project is view only/i);
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
});

describe('generic filesystem authority remains current', () => {
  it('preserves every copied member after partial cross-device source removal', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const target = join(root, 'new');
    await mkdir(target);
    const move = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:move')!;
    host.crossDeviceSource = packageRoot;
    host.partialRemoval = packageRoot;
    await expect(move(event(), packageRoot, target)).rejects.toThrow(
      'injected partial source removal'
    );
    await expect(stat(join(packageRoot, 'sequence.gb'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'package', 'sequence.gb'), 'utf8')).toBe('sequence bytes');
    expect(await readFile(join(target, 'package', 'publication.marker'), 'utf8')).toBe('original');
  });
  it('preserves a concurrent destination claimant when the cross-device copy is ready to publish', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const destination = join(root, 'new');
    await mkdir(destination);
    const occupied = join(destination, 'package');
    host.crossDeviceSource = packageRoot;
    host.beforePromotion.mockImplementation((from: string, to: string) => {
      if (basename(from) === 'copy' && to === occupied) mkdirSync(occupied);
    });
    const move = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:move')!;
    await expect(move(event(), packageRoot, destination)).rejects.toThrow('MOVE_EXISTS');
    expect(await readdir(occupied)).toEqual([]);
    expect(await readFile(join(packageRoot, 'sequence.gb'), 'utf8')).toBe('sequence bytes');
  });
  it('rejects corrupt copied bytes before publication or source removal', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    host.crossDeviceSource = host.marker;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(cp).mockImplementationOnce(async (source, target, options) => {
      await actual.cp(source, target, options);
      await writeFile(target, 'different');
    });
    await expect(invokeGeneric('move')).rejects.toThrow('differs from its source');
    expect(await readFile(host.marker, 'utf8')).toBe('original');
    await expect(stat(join(root, 'publication.marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves both copies when permission changes after destination publication', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    host.crossDeviceSource = host.marker;
    host.beforePromotion.mockImplementation((_from: string, to: string) => {
      if (basename(to) === 'original')
        host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
    });
    await expect(invokeGeneric('move')).rejects.toThrow(/shared project is view only/i);
    expect(await readFile(host.marker, 'utf8')).toBe('original');
    expect(await readFile(join(root, 'publication.marker'), 'utf8')).toBe('original');
  });
  it('preserves changed source bytes when a concurrent edit intervenes after copying', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    host.crossDeviceSource = host.marker;
    host.beforePromotion.mockImplementation((from: string, to: string) => {
      if (basename(to) === 'original') writeFileSync(from, 'a later edit');
    });
    await expect(invokeGeneric('move')).rejects.toThrow('differs from its source');
    expect(await readFile(host.marker, 'utf8')).toBe('a later edit');
    expect(await readFile(join(root, 'publication.marker'), 'utf8')).toBe('original');
  });
  it('preserves a replaced destination and the source after publication', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const destination = join(root, 'publication.marker');
    const retainedCopy = join(root, 'retained.marker');
    host.crossDeviceSource = host.marker;
    host.beforePromotion.mockImplementation((_from: string, to: string) => {
      if (basename(to) === 'original') {
        renameSync(destination, retainedCopy);
        writeFileSync(destination, 'replacement');
      }
    });
    await expect(invokeGeneric('move')).rejects.toThrow(/source or destination was replaced/);
    expect(await readFile(host.marker, 'utf8')).toBe('original');
    expect(await readFile(destination, 'utf8')).toBe('replacement');
    expect(await readFile(retainedCopy, 'utf8')).toBe('original');
  });
  it('finishes an admitted cross-device move with its nested members and relative links intact', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const target = join(root, 'new');
    await mkdir(target);
    await mkdir(join(packageRoot, 'empty'));
    if (process.platform !== 'win32') await symlink('sequence.gb', join(packageRoot, 'alias'));
    const move = new Map(vi.mocked(ipcMain.handle).mock.calls).get('fs:move')!;
    host.crossDeviceSource = packageRoot;
    expect(await move(event(), packageRoot, target)).toMatchObject({
      destPath: join(target, 'package'),
    });
    expect(await readFile(join(target, 'package', 'sequence.gb'), 'utf8')).toBe('sequence bytes');
    expect(await readdir(join(target, 'package', 'empty'))).toEqual([]);
    if (process.platform !== 'win32')
      expect(await readFile(join(target, 'package', 'alias'), 'utf8')).toBe('sequence bytes');
    await expect(stat(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(target)).toEqual(['package']);
  });
  it('preserves the occupied destination of a raw rename', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const target = join(root, 'renamed.marker');
    await writeFile(target, 'occupied');
    await expect(invokeGeneric('rename')).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('occupied');
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
  it('refuses the copy fallback when access is revoked during a cross-device rename', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    host.revokeOnCrossDeviceRename = true;
    vi.mocked(cp).mockClear();
    await expect(invokeGeneric('move')).rejects.toThrow(/shared project is view only/i);
    expect(cp).not.toHaveBeenCalled();
    expect(await readFile(host.marker, 'utf8')).toBe('original');
    await expect(stat(join(root, 'publication.marker'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(genericKinds)('allows the same %s request after editor promotion', async (kind) => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    await invokeGeneric(kind);
    if (kind === 'mkdir')
      expect((await stat(join(root, 'created-folder'))).isDirectory()).toBe(true);
    else if (kind === 'rename')
      expect(await readFile(join(root, 'renamed.marker'), 'utf8')).toBe('original');
    else if (kind === 'move')
      expect(await readFile(join(root, 'publication.marker'), 'utf8')).toBe('original');
    else expect(await readFile(host.marker, 'utf8')).toBe('changed');
  });
  it('rechecks a demotion while the write waits for the real workspace lease', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = invokeGeneric('writeTextFile');
    const refused = expect(pending).rejects.toThrow(/shared project is view only/i);
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
    } finally {
      release();
    }
    await refused;
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
  it('preserves ordinary unshared project writes', async () => {
    host.db!.prepare('DELETE FROM workspace_sync_bindings').run();
    await invokeGeneric('writeTextFile');
    expect(await readFile(host.marker, 'utf8')).toBe('changed');
  });
});

describe('committed project ownership classification', () => {
  it('does not treat uncommitted project removal as an unmanaged path', async () => {
    host.db!.exec('BEGIN');
    host.db!.prepare('DELETE FROM workspaces WHERE id=7').run();
    try {
      await expect(invokeGeneric('writeTextFile')).rejects.toThrow(
        /committed|transaction|database/i
      );
    } finally {
      host.db!.exec('ROLLBACK');
    }
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
});

function workspaceTextInput(mode: 'create' | 'replace') {
  return {
    workspaceRoot: root,
    path: mode === 'create' ? join(root, 'new.txt') : host.marker,
    mode,
    content: 'changed',
    ...(mode === 'replace'
      ? { expectedContentHash: createHash('sha256').update('original').digest('hex') }
      : {}),
    artifactNoun: 'text artifact',
  };
}

function invokeWorkspaceText(mode: 'create' | 'replace') {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(
    'fs:writeWorkspaceTextFileAtomic'
  );
  if (!handler) throw new Error('Missing actual workspace text write handler');
  return handler(event(), workspaceTextInput(mode));
}

describe('shared role at workspace text CAS IPC owner', () => {
  it.each(['create', 'replace'] as const)(
    'refuses Viewer %s and preserves canonical bytes',
    async (mode) => {
      await expect(invokeWorkspaceText(mode)).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/shared project is view only/i) },
      });
      expect(await readFile(host.marker, 'utf8')).toBe('original');
      if (mode === 'create')
        await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it.each(['create', 'replace'] as const)(
    'allows the identical %s after offline Editor promotion',
    async (mode) => {
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      await expect(invokeWorkspaceText(mode)).resolves.toMatchObject({ ok: true });
      expect(await readFile(workspaceTextInput(mode).path, 'utf8')).toBe('changed');
    }
  );

  it.each(['create', 'replace'] as const)(
    'refuses %s demoted after temporary bytes are complete',
    async (mode) => {
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
      const before = (await readdir(root)).sort();
      const packageBefore = (await readdir(packageRoot)).sort();
      host.beforeTextPublication.mockImplementationOnce(() => {
        host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
      });
      await expect(invokeWorkspaceText(mode)).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/shared project is view only/i) },
      });
      expect(host.beforeTextPublication).toHaveBeenCalledTimes(1);
      expect(await readFile(host.marker, 'utf8')).toBe('original');
      expect((await readdir(root)).sort()).toEqual(before);
      expect((await readdir(packageRoot)).sort()).toEqual(packageBefore);
    }
  );

  it('rechecks demotion while waiting for the real workspace lease', async () => {
    host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='editor'").run();
    const release = await acquireWorkspaceSyncMutationLease(root);
    const pending = invokeWorkspaceText('replace');
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      host.db!.prepare("UPDATE workspace_sync_bindings SET access_role='viewer'").run();
    } finally {
      release();
    }
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(await readFile(host.marker, 'utf8')).toBe('original');
  });
});
