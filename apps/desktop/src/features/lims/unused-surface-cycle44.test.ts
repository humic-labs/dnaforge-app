// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('cycle 44 unused exports', () => {
  it('removes helpers that had no caller and keeps the live neighbors', () => {
    expect(source('keyboard/shortcutRegistry.ts')).not.toMatch(/function shortcutChordKeys/);
    expect(source('keyboard/shortcutRegistry.ts')).toMatch(/export const APP_SHORTCUTS/);
    expect(source('db/index.ts')).not.toMatch(/function closeDatabase/);
    expect(source('db/index.ts')).not.toMatch(/function getSequenceById/);
    expect(source('db/index.ts')).toMatch(/function getSequenceWithPath/);
    expect(source('hooks/useMockedFileSystem.ts')).not.toMatch(/function useMockedFileSystem/);
    expect(source('hooks/useMockedFileSystem.ts')).toMatch(/function getFileSystem/);
    expect(source('db/data-stores-manifest.ts')).not.toMatch(/DATA_STORE_MANIFEST_VERSION/);
    expect(source('db/data-stores-manifest.ts')).not.toMatch(/export const DATA_STORES/);
    expect(source('db/data-stores-manifest.ts')).toMatch(/SQLITE_TABLE_DATA_STORES/);
    expect(source('db/data-stores-manifest.ts')).toMatch(/NON_SQLITE_DATA_STORES/);
    expect(source('components/SettingsSubsection.tsx')).not.toMatch(/function SettingsGroup/);
    expect(source('components/SettingsSubsection.tsx')).toMatch(/function SettingsSubsection/);
    expect(source('shared/context/index.ts')).not.toMatch(/usePanelContext/);
    expect(source('shared/context/index.ts')).toMatch(/PanelContextProvider/);
    expect(source('features/sequence/openSequenceFile.ts')).toMatch(/function openSequencePackage/);
    expect(source('features/document-opening/compat.ts')).not.toMatch(
      /function openSequencePackage/
    );
  });
});
