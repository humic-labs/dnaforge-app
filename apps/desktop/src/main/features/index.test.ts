// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../boot-log', () => ({ appendBootLog: vi.fn() }));
vi.mock('./remote-hosts', () => ({ remoteHostsFeature: { id: 'remote-hosts' } }));
vi.mock('./reference-assets', () => ({ referenceAssetsFeature: { id: 'reference-assets' } }));
vi.mock('./external-agent-tools', () => ({
  externalAgentToolsFeature: { id: 'external-agent-tools' },
}));
vi.mock('./track-store', () => ({ trackStoreFeature: { id: 'track-store' } }));
vi.mock('./entity-navigation', () => ({ entityNavigationFeature: { id: 'entity-navigation' } }));
vi.mock('./benchling-migration', () => ({
  benchlingMigrationFeature: { id: 'benchling-migration' },
}));
vi.mock('./auth', () => ({ authFeature: { id: 'auth' } }));
vi.mock('./credential-storage', () => ({
  credentialStorageFeature: { id: 'credential-storage' },
}));
vi.mock('./memory-pressure', () => ({ memoryPressureFeature: { id: 'memory-pressure' } }));
vi.mock('./beta-attribution', () => ({ betaAttributionFeature: { id: 'beta-attribution' } }));
vi.mock('./share-links', () => ({ shareLinksFeature: { id: 'share-links' } }));
vi.mock('./native-documents', () => ({ nativeDocuments: {} }));
vi.mock('./administration', () => ({ administrationFeature: { id: 'administration' } }));
vi.mock('./agent-tools-bridge', () => ({ agentToolsBridge: {} }));
vi.mock('./mcp-http', () => ({ startMcpHttpServices: () => undefined }));
vi.mock('./workspace-sync', () => ({ workspaceSync: {} }));
vi.mock('./file-associations', () => ({
  fileAssociations: {},
  fileAssociationsFeature: { id: 'file-associations' },
}));

import type { BrowserWindow } from 'electron';
import {
  mainFeaturesSignedIn,
  mainFeaturesWillQuit,
  findMainFeatureProtocolUrlInArgv,
  configureMainFeatureProfile,
  MAIN_FEATURES,
  openMainFeatureProtocolUrl,
  prepareMainFeatures,
  routeMainFeatureProtocolUrl,
  registerMainFeatureIpc,
  startMainAgentTools,
  startMainFeaturesWithWindow,
} from '.';
import type { MainAgentToolsContext, MainFeature, MainFeatureContext } from './main-feature';

const NO_WINDOW: MainFeatureContext = { getMainWindow: () => null };

function recordingFeature(id: string, log: string[]): MainFeature {
  return {
    id,
    prepare: async () => {
      await Promise.resolve();
      log.push(`${id}:prepare`);
    },
    registerIpc: () => {
      log.push(`${id}:ipc`);
      return () => log.push(`${id}:dispose`);
    },
    onMainWindow: () => log.push(`${id}:window`),
    willQuit: () => log.push(`${id}:quit`),
  };
}

describe('main feature lifecycle', () => {
  it('configures profile policy synchronously before later feature preparation', async () => {
    const log: string[] = [];
    const profile = { isolated: true };
    const features: MainFeature[] = ['a', 'b'].map((id) => ({
      id,
      configureProfile: (context) => {
        expect(context).toBe(profile);
        log.push(`${id}:profile`);
      },
      prepare: () => {
        log.push(`${id}:prepare`);
      },
    }));
    configureMainFeatureProfile(profile, features);
    expect(log).toEqual(['a:profile', 'b:profile']);
    await prepareMainFeatures(NO_WINDOW, features);
    expect(log).toEqual(['a:profile', 'b:profile', 'a:prepare', 'b:prepare']);
  });

  it('runs each hook for every feature in list order, awaiting each prepare', async () => {
    const log: string[] = [];
    const features = [recordingFeature('a', log), recordingFeature('b', log)];
    await prepareMainFeatures(NO_WINDOW, features);
    const dispose = registerMainFeatureIpc(features);
    startMainFeaturesWithWindow({} as BrowserWindow, NO_WINDOW, features);
    mainFeaturesWillQuit(features);
    dispose();
    expect(log).toEqual([
      'a:prepare',
      'b:prepare',
      'a:ipc',
      'b:ipc',
      'a:window',
      'b:window',
      'a:quit',
      'b:quit',
      'b:dispose',
      'a:dispose',
    ]);
  });

  it('recovers scientific records before Benchling migration, tracks and reference assets', () => {
    expect(MAIN_FEATURES.map((feature) => feature.id)).toEqual([
      'credential-storage',
      'scientific-recovery',
      'benchling-migration',
      'track-store',
      'remote-hosts',
      'third-party-notices',
      'external-agent-tools',
      'reference-assets',
      'entity-navigation',
      'auth',
      'memory-pressure',
      'beta-attribution',
      'share-links',
      'file-associations',
      'app-health',
      'administration',
    ]);
  });

  it('routes a protocol URL to the first feature that accepts it and preserves the foreground request context', () => {
    const context = { window: null, activate: vi.fn() };
    const first = { id: 'unrelated', onProtocolUrl: vi.fn(() => false) };
    const second = { id: 'entity', onProtocolUrl: vi.fn(() => true) };
    const third = { id: 'later', onProtocolUrl: vi.fn(() => true) };
    expect(
      routeMainFeatureProtocolUrl('dnaforge://entity/open?entityId=one', context, [
        first,
        second,
        third,
      ])
    ).toBe(true);
    expect(second.onProtocolUrl).toHaveBeenCalledWith(
      'dnaforge://entity/open?entityId=one',
      context
    );
    expect(third.onProtocolUrl).not.toHaveBeenCalled();
    expect(routeMainFeatureProtocolUrl('dnaforge://auth/callback', context, [first])).toBe(false);
    expect(context.activate).not.toHaveBeenCalled();
  });

  it('opens a protocol URL with the first matching route in feature and route order', () => {
    const opened: string[] = [];
    const route = (name: string, prefix: string) => ({
      matches: (url: string) => url.startsWith(prefix),
      open: (url: string, context: MainFeatureContext) => {
        expect(context).toBe(NO_WINDOW);
        opened.push(`${name} ${url}`);
      },
    });
    const features: MainFeature[] = [
      { id: 'first', protocolRoutes: [route('first-a', 'app://a'), route('first-any', 'app://')] },
      { id: 'second', protocolRoutes: [route('second-b', 'app://b')] },
    ];

    expect(openMainFeatureProtocolUrl('app://b/1', NO_WINDOW, features)).toBe(true);
    expect(openMainFeatureProtocolUrl('app://a/2', NO_WINDOW, features)).toBe(true);
    expect(openMainFeatureProtocolUrl('other://c', NO_WINDOW, features)).toBe(false);
    expect(opened).toEqual(['first-any app://b/1', 'first-a app://a/2']);
  });

  it('tells every feature about sign-in in list order with the same context', () => {
    const signedIn: string[] = [];
    const feature = (id: string): MainFeature => ({
      id,
      onSignedIn: (context) => {
        expect(context).toBe(NO_WINDOW);
        signedIn.push(id);
      },
    });

    mainFeaturesSignedIn(NO_WINDOW, [feature('a'), { id: 'quiet' }, feature('b')]);

    expect(signedIn).toEqual(['a', 'b']);
  });

  it('runs reference assets and external agent tools hooks in startup order', async () => {
    const log: string[] = [];
    const agentTools: MainFeature = {
      id: 'external-agent-tools',
      startAgentTools: async () => {
        await Promise.resolve();
        log.push('external-agent-tools:startAgentTools');
      },
    };
    const features = [agentTools, recordingFeature('reference-assets', log)];
    await prepareMainFeatures(NO_WINDOW, features);
    const dispose = registerMainFeatureIpc(features);
    startMainFeaturesWithWindow({} as BrowserWindow, NO_WINDOW, features);
    await startMainAgentTools({} as MainAgentToolsContext, features);
    mainFeaturesWillQuit(features);
    dispose();
    expect(log).toEqual([
      'reference-assets:prepare',
      'reference-assets:ipc',
      'reference-assets:window',
      'external-agent-tools:startAgentTools',
      'reference-assets:quit',
      'reference-assets:dispose',
    ]);
  });

  it('finds native command-line URLs through their registered feature without activating a window', () => {
    const url = 'dnaforge-dev-1827://entity/open?entityId=one';
    const first = { id: 'unrelated', findProtocolUrlInArgv: vi.fn(() => null) };
    const entity = { id: 'entity', findProtocolUrlInArgv: vi.fn(() => url) };
    const later = { id: 'later', findProtocolUrlInArgv: vi.fn(() => null) };
    const argv = ['native-app', url];
    expect(findMainFeatureProtocolUrlInArgv(argv, [first, entity, later])).toBe(url);
    expect(entity.findProtocolUrlInArgv).toHaveBeenCalledWith(argv);
    expect(later.findProtocolUrlInArgv).not.toHaveBeenCalled();
    expect(findMainFeatureProtocolUrlInArgv(argv, [first])).toBeNull();
  });

  it('hands every prepare the same context, whose window accessor reads the live window', async () => {
    const windows = [{ id: 1 } as BrowserWindow, { id: 2 } as BrowserWindow];
    let current: BrowserWindow | null = windows[0];
    const seen: Array<BrowserWindow | null> = [];
    const contexts: MainFeatureContext[] = [];
    const reader = (id: string): MainFeature => ({
      id,
      prepare: (context) => {
        contexts.push(context);
      },
    });
    const context: MainFeatureContext = { getMainWindow: () => current };
    await prepareMainFeatures(context, [reader('a'), reader('b')]);
    expect(contexts).toEqual([context, context]);
    seen.push(contexts[0].getMainWindow());
    current = windows[1];
    seen.push(contexts[0].getMainWindow());
    current = null;
    seen.push(contexts[1].getMainWindow());
    expect(seen).toEqual([windows[0], windows[1], null]);
  });

  it('hands every window hook the window and the same live context', () => {
    const window = { id: 7 } as BrowserWindow;
    const received: Array<[BrowserWindow, MainFeatureContext]> = [];
    const hook = (id: string): MainFeature => ({
      id,
      onMainWindow: (shown, context) => {
        received.push([shown, context]);
      },
    });
    startMainFeaturesWithWindow(window, NO_WINDOW, [hook('a'), hook('b')]);
    expect(received).toEqual([
      [window, NO_WINDOW],
      [window, NO_WINDOW],
    ]);
  });

  it('binds the root context to the live main window variable', () => {
    const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(root).toContain(
      'const mainFeatureContext = { getMainWindow: (): BrowserWindow | null => mainWindowRef };'
    );
    expect(root).not.toMatch(/register(Auth|MemoryPressure)Handlers/);
  });

  it('configures profile isolation after the profile is resolved and before lock acquisition', () => {
    const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const configure = root.indexOf('configureMainFeatureProfile({');
    const profileReady = root.indexOf("mkdirSync(app.getPath('userData'), { recursive: true });");
    const lock = root.indexOf('app.requestSingleInstanceLock(');
    expect(profileReady).toBeGreaterThan(0);
    expect(configure).toBeGreaterThan(profileReady);
    expect(lock).toBeGreaterThan(configure);
    expect(root.slice(configure, lock)).toContain("process.env.WAYPOINT_TEST === '1'");
    expect(root.slice(configure, lock)).toContain('hasExplicitUserDataDir(process.argv)');
    expect(root.slice(configure, lock)).toContain("startupProfile.kind === 'scenario-disposable'");
  });

  it('gives IPC registration the feature-owned workspaces and bridge instead of root arguments', () => {
    const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const ipc = readFileSync(new URL('../ipc/index.ts', import.meta.url), 'utf8');
    expect(ipc).toMatch(/registerTerminalIpc\([\s\S]*?nativeDocuments\.workspaces\s*\);/);
    expect(ipc).toContain(
      'registerHostedAiGatewayHandlers({ getAgentToolsBridge: () => agentToolsBridge.current() });'
    );
    const call = root.slice(root.indexOf('registerAllIpcHandlers({'));
    const callArguments = call.slice(0, call.indexOf('\n  });'));
    expect(callArguments).toContain('terminalTrustedRendererUrl');
    expect(callArguments).not.toMatch(
      /terminalWorkspaceAccess|getAgentToolsBridge|fileAssociations/
    );
  });

  it('calls the lifecycle in that order from the main-process root', () => {
    const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const ipc = readFileSync(new URL('../ipc/index.ts', import.meta.url), 'utf8');
    const positions = [
      'await prepareMainFeatures(mainFeatureContext);',
      'registerAllIpcHandlers({',
      'startMainFeaturesWithWindow(mainWindow, mainFeatureContext);',
      'await startMainAgentTools({',
    ].map((call) => {
      expect(root.split(call)).toHaveLength(2);
      return root.indexOf(call);
    });
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(ipc).toContain('registerMainFeatureIpc();');
    expect(root.indexOf('mainFeaturesWillQuit();')).toBeGreaterThan(
      root.indexOf("app.once('will-quit', () => {")
    );
  });
});
