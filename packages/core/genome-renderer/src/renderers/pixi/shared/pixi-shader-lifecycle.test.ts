import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { GlProgram, Shader } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { destroyLayerShader } from './pixi-shader-lifecycle';

describe('destroyLayerShader', () => {
  it('preserves the GlProgram shared by peer layers', () => {
    const options = {
      name: 'shared-program-lifecycle-test',
      vertex: `
        precision highp float;
        attribute float aCorner;
        void main() { gl_Position = vec4(aCorner, 0.0, 0.0, 1.0); }
      `,
      fragment: `
        precision mediump float;
        void main() { gl_FragColor = vec4(1.0); }
      `,
    };
    const firstProgram = GlProgram.from(options);
    const peerProgram = GlProgram.from(options);
    expect(peerProgram).toBe(firstProgram);

    const layerShader = new Shader({ glProgram: firstProgram, resources: {} });
    destroyLayerShader(layerShader);

    expect(peerProgram.fragment).not.toBeNull();
    expect(peerProgram.vertex).not.toBeNull();
  });

  it('forbids Pixi layers from destroying a shader-owned shared program', async () => {
    const pixiRoot = resolve(process.cwd(), 'src/renderers/pixi');
    const sourcePaths = await collectTypeScriptSources(pixiRoot);
    const violations: string[] = [];
    const destructiveShaderTeardown =
      /(?:shader|Shader)[^\n;]*\.destroy\(\s*true\s*\)|\.destroy\(\s*true\s*\)[^\n;]*(?:shader|Shader)/g;

    for (const path of sourcePaths) {
      if (path.includes('/shared/pixi-shader-lifecycle.')) continue;
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(destructiveShaderTeardown)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.slice(pixiRoot.length + 1)}:${line}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return collectTypeScriptSources(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    })
  );
  return paths.flat();
}
