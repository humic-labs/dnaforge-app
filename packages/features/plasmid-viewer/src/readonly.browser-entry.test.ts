import { resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as compatibilityEntry from './readonly';
import * as canonicalEntry from '@waypoint/readonly-sequence-viewer';

const FORBIDDEN_IMPORT =
  /^(?:node:|electron(?:\/|$)|pixi\.js(?:\/|$)|@waypoint\/(?:analytics-policy|genome-data|genome-renderer|platform|share-bundle|workspace-editor)(?:\/|$)|@(?:auth|aws-sdk|supabase|workos-inc)\/|jose(?:\/|$)|next-auth(?:\/|$))|[?&]worker(?:&|$)/u;
const FORBIDDEN_BROWSER_RUNTIME =
  /\b(?:localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket)\b|\bfetch\s*\(/u;

describe('@waypoint/plasmid-viewer/readonly browser entry', () => {
  it('bundles the public subpath without desktop, Node, storage, or network dependencies', async () => {
    const result = await esbuild.build({
      stdin: {
        contents: "export * from '@waypoint/plasmid-viewer/readonly';",
        loader: 'ts',
        resolveDir: resolve(import.meta.dirname, '..'),
        sourcefile: 'readonly-browser-entry.ts',
      },
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      logLevel: 'silent',
      metafile: true,
      platform: 'browser',
      plugins: [
        {
          name: 'reject-forbidden-readonly-imports',
          setup(build): void {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (!FORBIDDEN_IMPORT.test(args.path)) return null;
              return {
                errors: [{ text: `Forbidden readonly-viewer import: ${args.path}` }],
              };
            });
          },
        },
      ],
      sourcemap: false,
      treeShaking: true,
      write: false,
    });

    expect(
      Object.keys(result.metafile.inputs).some((input) => input.endsWith('src/readonly.ts'))
    ).toBe(true);
    expect(
      Object.keys(result.metafile.inputs).some(
        (input) => input.includes('readonly-sequence-viewer') && input.endsWith('src/index.ts')
      )
    ).toBe(true);
    const output = result.outputFiles.map((file) => file.text).join('\n');
    expect(output).not.toMatch(FORBIDDEN_BROWSER_RUNTIME);
  });

  it('preserves the canonical runtime exports by identity', () => {
    expect(compatibilityEntry.loadReadonlyGenBank).toBe(canonicalEntry.loadReadonlyGenBank);
    expect(compatibilityEntry.ReadonlyPlasmidViewer).toBe(canonicalEntry.ReadonlyPlasmidViewer);
  });
});
