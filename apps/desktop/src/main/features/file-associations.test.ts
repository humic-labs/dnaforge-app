// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_LOOK_PACKAGE_STORE_DIRECTORY } from '../../shared/file-associations';

type HandlerDeps = {
  takePendingAndMarkReady: () => Array<{ deliveryId: string; path: string; familyId: string }>;
  defaultHandler: unknown;
  materializeQuickLookPackage: (request: unknown) => unknown;
  prepareQuickLookPackage: (request: { packageRoot: string }) => unknown;
  promoteQuickLookPackage: (request: unknown) => unknown;
};
type PromotionSteps = {
  prepareWorkspace: (name: string) => unknown;
  activateWorkspace: (workspace: unknown) => unknown;
  promoteToRoot: (receipt: unknown, targetRoot: string) => unknown;
  discardWorkspace: (workspace: unknown) => unknown;
};

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  nativeDeps: vi.fn((options: unknown) => ({ native: options })),
  defaultHandler: vi.fn((deps: unknown) => ({ handler: deps })),
  store: { materialize: vi.fn(), preparePackage: vi.fn(), promote: vi.fn() },
  createStore: vi.fn(),
  promote: vi.fn(),
  register: vi.fn(),
  db: { name: 'db' },
  prepareWorkspace: vi.fn(),
  activateWorkspace: vi.fn(),
  importGeneration: vi.fn(),
  discardWorkspace: vi.fn(),
  recoverWorkspaces: vi.fn(),
  recoverPromotions: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../file-associations/default-handler-service', () => ({
  createDefaultHandlerService: mocks.defaultHandler,
}));
vi.mock('../file-associations/native-default-handler', () => ({
  createNativeDefaultHandlerDependencies: mocks.nativeDeps,
}));
vi.mock('../file-associations/quick-look-package-store', () => ({
  createQuickLookPackageStore: mocks.createStore,
}));
vi.mock('../file-associations/quick-look-destination-promotion', () => ({
  promoteQuickLookToDestination: mocks.promote,
}));
vi.mock('../ipc/database', () => ({ getDb: () => mocks.db }));
vi.mock('../ipc/file-associations', () => ({ registerFileAssociationHandlers: mocks.register }));
vi.mock('../ipc/workspace-git', () => ({ managedRootDir: () => '/managed' }));
vi.mock('../workspace-git/import', () => ({
  prepareQuickLookDestinationWorkspace: mocks.prepareWorkspace,
  activatePreparedQuickLookDestinationWorkspace: mocks.activateWorkspace,
  importQuickLookGenerationIntoWorkspaceRoot: mocks.importGeneration,
  discardPreparedQuickLookDestinationWorkspace: mocks.discardWorkspace,
  recoverQuickLookDestinationWorkspaces: mocks.recoverWorkspaces,
  recoverQuickLookPackagePromotions: mocks.recoverPromotions,
}));

import { createFileAssociations } from './file-associations';

const USER_DATA = '/user-data';
const PROMOTIONS = join(USER_DATA, QUICK_LOOK_PACKAGE_STORE_DIRECTORY, '.promotions');
const PREPARATIONS = join(PROMOTIONS, 'workspace-preparations');
const CONFIGURATION = {
  userDataPath: USER_DATA,
  helperSourcePath: '/helpers/association.m',
  openExternal: mocks.openExternal,
};

let fixtureDir: string;
let genbank: string;

function registeredDeps(): HandlerDeps {
  const deps = mocks.register.mock.calls.at(-1)?.[0] as HandlerDeps | undefined;
  if (!deps) throw new Error('file association handlers were not registered');
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createStore.mockReturnValue(mocks.store);
  mocks.recoverPromotions.mockResolvedValue(undefined);
  mocks.recoverWorkspaces.mockResolvedValue(undefined);
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'file-associations-feature-')));
  genbank = join(fixtureDir, 'plasmid.gb');
  writeFileSync(genbank, 'LOCUS       plasmid\n//\n');
});

afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

describe('file associations main feature', () => {
  it('buffers a file opened before configuration and hands it to the renderer exactly once', () => {
    const feature = createFileAssociations();

    expect(feature.activationQueue.enqueue([genbank])).toEqual([]);
    expect(feature.activationQueue.enqueue([genbank])).toEqual([]);
    expect(() => feature.feature.registerIpc?.()).toThrow(
      'File associations were used before they were configured.'
    );

    feature.configure(CONFIGURATION);
    feature.feature.registerIpc?.();
    const deps = registeredDeps();

    expect(deps.takePendingAndMarkReady()).toEqual([
      { deliveryId: 'file-activation-1', path: genbank, familyId: 'genbank' },
    ]);
    expect(deps.takePendingAndMarkReady()).toEqual([]);
    expect(feature.activationQueue.enqueue([genbank])).toEqual([
      { deliveryId: 'file-activation-2', path: genbank, familyId: 'genbank' },
    ]);
  });

  it('configures the package store and the native default handler from the user-data path', async () => {
    const feature = createFileAssociations();
    feature.configure(CONFIGURATION);

    expect(mocks.createStore).toHaveBeenCalledWith(USER_DATA);
    expect(mocks.nativeDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: process.platform,
        appBundleId: 'com.dnaforge.desktop',
        isPackaged: false,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        helperSourcePath: '/helpers/association.m',
        userDataPath: USER_DATA,
      })
    );
    const { openExternal } = mocks.nativeDeps.mock.calls[0]?.[0] as {
      openExternal: (url: string) => unknown;
    };
    openExternal('https://example.test/settings');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.test/settings');

    feature.feature.registerIpc?.();
    expect(registeredDeps().defaultHandler).toBe(mocks.defaultHandler.mock.results[0]?.value);
  });

  it('recovers interrupted package promotions before destination workspaces, failing closed', async () => {
    const feature = createFileAssociations();
    await expect(feature.recoverPromotions()).rejects.toThrow('before they were configured');

    feature.configure(CONFIGURATION);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.recoverPromotions.mockRejectedValueOnce(new Error('journal locked'));
    await feature.recoverPromotions();

    expect(mocks.recoverPromotions).toHaveBeenCalledWith(PROMOTIONS, {
      db: mocks.db,
      managedRootDir: '/managed',
    });
    expect(mocks.recoverWorkspaces).toHaveBeenCalledWith({
      db: mocks.db,
      managedRootDir: '/managed',
      preparationJournalRoot: PREPARATIONS,
      packagePromotionJournalRoot: PROMOTIONS,
    });
    expect(mocks.recoverPromotions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recoverWorkspaces.mock.invocationCallOrder[0] ?? 0
    );
    expect(warn).toHaveBeenCalledWith(
      '[main] Quick Look promotion recovery failed closed:',
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('routes Quick Look packages through the store and the destination promotion steps', () => {
    const feature = createFileAssociations();
    feature.configure(CONFIGURATION);
    feature.feature.registerIpc?.();
    const deps = registeredDeps();

    deps.materializeQuickLookPackage({ source: 'a' });
    expect(mocks.store.materialize).toHaveBeenCalledWith({ source: 'a' });
    deps.prepareQuickLookPackage({ packageRoot: '/pkg' });
    expect(mocks.store.preparePackage).toHaveBeenCalledWith('/pkg');

    deps.promoteQuickLookPackage({ request: 'promote' });
    expect(mocks.promote).toHaveBeenCalledWith({ request: 'promote' }, expect.any(Object));
    const steps = mocks.promote.mock.calls[0]?.[1] as PromotionSteps;
    const workspaceOptions = {
      db: mocks.db,
      managedRootDir: '/managed',
      preparationJournalRoot: PREPARATIONS,
      packagePromotionJournalRoot: PROMOTIONS,
    };
    steps.prepareWorkspace('Imported');
    expect(mocks.prepareWorkspace).toHaveBeenCalledWith('Imported', workspaceOptions);
    steps.activateWorkspace({ id: 'w' });
    expect(mocks.activateWorkspace).toHaveBeenCalledWith({ id: 'w' }, workspaceOptions);
    steps.discardWorkspace({ id: 'w' });
    expect(mocks.discardWorkspace).toHaveBeenCalledWith({ id: 'w' }, workspaceOptions);

    steps.promoteToRoot({ receipt: 'r' }, '/target');
    expect(mocks.store.promote).toHaveBeenCalledWith(
      { receipt: { receipt: 'r' }, targetRoot: '/target' },
      expect.any(Function)
    );
    const importer = mocks.store.promote.mock.calls[0]?.[1] as (
      snapshot: unknown,
      physicalTargetRoot: string
    ) => unknown;
    importer({ snapshot: 's' }, '/physical');
    expect(mocks.importGeneration).toHaveBeenCalledWith({ snapshot: 's' }, '/physical', {
      db: mocks.db,
      managedRootDir: '/managed',
      promotionJournalRoot: PROMOTIONS,
    });
  });
});
