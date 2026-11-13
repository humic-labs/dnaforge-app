// @vitest-environment node

import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CODEX_SDK_VERSION, CODEX_SDK_THREAD_ITEM_POLICY } from '../native-tool-capabilities';

describe('installed Codex SDK capability discovery', () => {
  it('classifies every thread item exposed by the exact installed SDK', () => {
    let searchDirectory = process.cwd();
    let sdkDirectory: string | null = null;
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = join(searchDirectory, 'node_modules', '@openai', 'codex-sdk', 'dist');
      if (existsSync(join(candidate, 'index.d.ts'))) {
        sdkDirectory = candidate;
        break;
      }
      const parent = dirname(searchDirectory);
      if (parent === searchDirectory) break;
      searchDirectory = parent;
    }
    expect(sdkDirectory, 'installed @openai/codex-sdk declarations').not.toBeNull();
    const packageJson = JSON.parse(
      readFileSync(join(sdkDirectory!, '..', 'package.json'), 'utf8')
    ) as { version: string };
    const declarations = readFileSync(join(sdkDirectory!, 'index.d.ts'), 'utf8');
    const threadItemUnion = declarations.match(/type ThreadItem = ([^;]+);/)?.[1];
    expect(threadItemUnion).toBeDefined();

    const declaredTypeNames = threadItemUnion!.split('|').map((name) => name.trim());
    const discoveredItemTypes = declaredTypeNames.map((typeName) => {
      const declaration = declarations.match(
        new RegExp(`type ${typeName} = \\{[\\s\\S]*?type: \\"([^\\"]+)\\";[\\s\\S]*?\\n\\};`)
      );
      expect(declaration, `missing item type discriminator for ${typeName}`).not.toBeNull();
      return declaration![1];
    });

    expect(packageJson.version).toBe(CODEX_SDK_VERSION);
    expect(discoveredItemTypes).toEqual(Object.keys(CODEX_SDK_THREAD_ITEM_POLICY));
  });
});
