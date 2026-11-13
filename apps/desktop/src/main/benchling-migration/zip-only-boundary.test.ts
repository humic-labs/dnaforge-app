import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(__dirname, '../../..');

const retiredRuntimeFiles = [
  'src/main/benchling-migration/engine.ts',
  'src/main/benchling-migration/live-provider.ts',
  'src/main/benchling-migration/replay-provider.ts',
  'src/main/benchling-migration/live-preflight-planner.ts',
  'src/main/benchling-migration/live-native-export-decoder.ts',
  'src/main/benchling-migration/live-targeted-read-decoder.ts',
  'src/main/benchling-migration/remote-zip-inspection.ts',
  'src/main/benchling-migration/replay-folder-catalog.ts',
  'src/shared/benchling-migration-live-canary.ts',
] as const;

const rendererCallableSurface = [
  'src/shared/benchling-migration-ipc.ts',
  'src/main/ipc/benchling-migration.ts',
  'src/features/benchling-migration/types.ts',
  'src/features/benchling-migration/platform-adapter.ts',
  'src/platform/index.ts',
  'src/platform/electron.ts',
  'src/platform/browser-mock-benchling-migration.ts',
  'src/preload/index.ts',
  'src/preload/index.d.ts',
] as const;

const retiredBridgeChannels = [
  'benchlingMigration:getCapabilities',
  'benchlingMigration:createRun',
  'benchlingMigration:listFolderChildren',
  'benchlingMigration:detectIdentity',
  'benchlingMigration:confirmIdentity',
  'benchlingMigration:getCompanionStatus',
  'benchlingMigration:startCompanionBootstrap',
  'benchlingMigration:disconnectCompanion',
  'benchlingMigration:confirmReceipt',
  'benchlingMigration:discoverFolderContents',
  'benchlingMigration:openCompanionExtensionDirectory',
] as const;

describe('Benchling ZIP-only source boundary', () => {
  it('does not ship the retired provider runtimes', () => {
    for (const relativePath of retiredRuntimeFiles) {
      expect(existsSync(resolve(desktopRoot, relativePath)), relativePath).toBe(false);
    }
  });

  it('does not expose provider, companion, or folder-discovery methods to the renderer', () => {
    const surface = rendererCallableSurface
      .map((relativePath) => readFileSync(resolve(desktopRoot, relativePath), 'utf8'))
      .join('\n');
    for (const channel of retiredBridgeChannels) {
      expect(surface, channel).not.toContain(channel);
    }
  });
});
