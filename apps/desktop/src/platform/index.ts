import { serviceManager } from '../services/service-manager';
import { configureApiClient } from '@waypoint/api-client';
import { waitForWorkspaceSyncDatabase } from '../db/workspace-sync-retry';
import type { PlatformBridge } from './types';
import type { PrepackedAnnotationSceneLoadInput } from '@waypoint/genome-renderer';
import type { UnpackedPartitionedTranscriptSceneBinaryV4 } from '@waypoint/genome-renderer/pure';
import type { GenomeSearchRequestIdentityV1 } from '../shared/indexed-genome';
import {
  DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY,
  parseStoredDeveloperImportSourceRoots,
  setRememberedDeveloperImportSourceRootsForRenderer,
} from '../shared/developer-import-sources';

export interface GenomeSearchRequestControlV1 extends GenomeSearchRequestIdentityV1 {
  signal?: AbortSignal;
}

export type TrustedAssemblyAnnotationSceneV4 = UnpackedPartitionedTranscriptSceneBinaryV4 & {
  rendererAdmissionCapability: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionV4']
  >;
  rendererAdmissionProvenance: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionProvenanceV4']
  >;
  rendererAdmissionLoadIdentity: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionLoadIdentityV4']
  >;
  colorRoles?: PrepackedAnnotationSceneLoadInput['colorRoles'];
};

export type * from '../shared/agent-runtime-ipc';
export type * from '../shared/agent-capability-controls';

export type * from './types';
let _bridge: PlatformBridge | null = null;
let _initPromise: Promise<PlatformBridge> | null = null;

export function initPlatform(): Promise<PlatformBridge> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    let bridge: PlatformBridge;
    if (
      import.meta.env.MODE === 'hosted' ||
      (typeof document !== 'undefined' &&
        document.documentElement.dataset.dnaforgeRuntime === 'hosted-browser')
    ) {
      const mod = await import('./hosted');
      bridge = mod.hostedBrowserBridge;
      console.log('[Platform] Hosted browser bridge initialized');
    } else if (typeof window !== 'undefined' && 'electronAPI' in window) {
      const mod = await import('./electron');
      bridge = mod.electronBridge;
      const rows = await waitForWorkspaceSyncDatabase(() =>
        bridge.db.select<Array<{ value: string }>>('SELECT value FROM settings WHERE key=?', [
          DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY,
        ])
      );
      setRememberedDeveloperImportSourceRootsForRenderer(
        parseStoredDeveloperImportSourceRoots(rows[0]?.value)
      );
      console.log('[Platform] Electron bridge initialized');
    } else {
      if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) {
        throw new Error(
          'The desktop preload bridge did not load. Reload the application. If this continues, reinstall the current DNAForge release.'
        );
      }
      if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) {
        throw new Error(
          'This build of DNAForge runs only in the desktop app or the hosted web app.'
        );
      }
      const mod = await import('./browser-mock');
      bridge = mod.browserMockBridge;
    }
    const apiUrl = await bridge.config.getApiUrl();
    serviceManager.setBaseUrl(apiUrl);
    configureApiClient({ baseUrl: apiUrl });
    console.log(`[Platform] API URL from main process: ${apiUrl}`);

    _bridge = bridge;
    void warmNativeFileChannels(bridge);

    return bridge;
  })();

  return _initPromise;
}

export function platform(): PlatformBridge {
  if (!_bridge) {
    throw new Error('Platform not initialized. Call initPlatform() first.');
  }
  return _bridge;
}

async function warmNativeFileChannels(bridge: PlatformBridge): Promise<void> {
  try {
    const appData = await bridge.path.appDataDir();
    const warmupPath = `${appData}/.ipc-warmup`;
    await bridge.fs.writeTextFile(warmupPath, 'x');
    await bridge.fs.readFile(warmupPath);
    await bridge.fs.readTextFile(warmupPath);
  } catch (error) {
    console.warn('[Platform] IPC warmup failed (non-fatal)', error);
  }
}
