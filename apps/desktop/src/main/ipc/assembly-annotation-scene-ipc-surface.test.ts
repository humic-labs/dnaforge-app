import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = (relativePath: string): string =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');

describe('assembly annotation-scene IPC surface', () => {
  it('keeps cache probing read-only and exposes no renderer preparation handler', () => {
    const main = source('./genome-data.ts');
    expect(main).toContain("'genome:readAssemblyAnnotationScene'");
    expect(main).toContain('readAssemblyAnnotationSceneCacheResource(input');
    expect(main).toContain('assemblyAnnotationSceneResourceRegistry.issue({');
    expect(main).not.toContain("'genome:prepareAssemblyAnnotationScene'");
    expect(main).not.toContain("'genome:scheduleAssemblyAnnotationProductIndexV1'");
    expect(main).toContain("'genome:writeAssemblyAnnotationScene'");
    expect(main).toContain('writeAssemblyAnnotationSceneCache(input');

    const readStart = main.indexOf("'genome:readAssemblyAnnotationScene'");
    const readEnd = main.indexOf("'genome:queryAssemblyAnnotationSearch'", readStart);
    const readHandler = main.slice(readStart, readEnd);
    expect(readHandler).toContain('assemblyAnnotationGenerationAuthorityV1(input)');
    expect(readHandler).not.toContain('compileFullGenomeExpandedAnnotationSceneOnMiss');
    expect(readHandler).not.toContain('prepareAssemblyAnnotationSceneOnMiss');
  });

  it('exposes metadata-only invoke through preload without binary conversion', () => {
    const preload = source('../../preload/indexed-genome-ipc.ts');
    expect(preload).toContain("rendererIpc.invoke('genome:readAssemblyAnnotationScene', input)");
    expect(preload).toContain(
      "rendererIpc.invoke('genome:readAssemblyCompiledBroadInteractionV1', input)"
    );
    expect(preload).not.toContain(
      "rendererIpc.invoke('genome:prepareAssemblyAnnotationScene', input)"
    );
    expect(preload).not.toContain(
      "rendererIpc.invoke('genome:scheduleAssemblyAnnotationProductIndexV1', input)"
    );
    expect(preload).toContain("rendererIpc.invoke('genome:writeAssemblyAnnotationScene', input)");
    const sceneLines = preload
      .split('\n')
      .filter((line) => line.includes('AssemblyAnnotationScene'))
      .join('\n');
    expect(sceneLines).not.toContain('base64');
    expect(sceneLines).not.toContain('arrayBuffer');
  });

  it('forwards Electron calls and makes the browser mock an independent cache miss', () => {
    const electron = source('../../platform/electron.ts');
    const browser = source('../../platform/browser-mock.ts');
    expect(electron).toContain('materializeAssemblyAnnotationSceneWireResult(wire, options)');
    expect(electron).not.toContain('prepareAssemblyAnnotationScene: (request) =>');
    expect(electron).not.toContain('api().genome.prepareAssemblyAnnotationScene(request)');
    expect(electron).toContain('response.arrayBuffer()');
    expect(electron).toContain('return new Uint8Array(ownedBuffer)');
    expect(electron).toContain(
      'writeAssemblyAnnotationScene: (request) => api().genome.writeAssemblyAnnotationScene(request)'
    );
    expect(browser).toContain('readAssemblyAnnotationScene: async () => null');
    expect(browser).toContain('readAssemblyCompiledBroadInteractionV1: async () => null');
    expect(browser).not.toContain('prepareAssemblyAnnotationScene: async () => ({');
    expect(browser).toContain('writeAssemblyAnnotationScene: async () => null');
  });

  it('exposes compact broad interaction through the same bounded one-use transport', () => {
    const main = source('./genome-data.ts');
    const start = main.indexOf("'genome:readAssemblyCompiledBroadInteractionV1'");
    const end = main.indexOf("'genome:queryAssemblyAnnotationSearch'", start);
    const handler = main.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('assemblyCompiledBroadInteractionAuthorityV1.read(');
    expect(handler).toContain("? 'portable-only'");
    expect(handler).toContain("? 'local-only'");
    expect(handler).toContain('assemblyAnnotationSceneResourceRegistry.issue({');
    expect(handler).toContain('ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1');
    expect(handler).not.toMatch(/payload\s*:/);
  });

  it('selects bounded detail from the same portable authority before legacy cache fallback', () => {
    const main = source('./genome-data.ts');
    const start = main.indexOf("'genome:readAssemblyAnnotationSceneDetailV1'");
    const end = main.indexOf("'genome:queryAssemblyAnnotationSearch'", start);
    const handler = main.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain("if (generationAuthority === 'portable')");
    expect(handler).toContain("if (generationAuthority === 'local') return readLocal()");
    expect(handler).toContain(
      'await portablePreparedReferenceViewAuthorityV1.readSceneIndex(request)'
    );
    expect(handler).toContain('readAssemblyAnnotationSceneCacheIndex(request');
  });

  it('registers the privileged scheme before ready and installs its handler before IPC', () => {
    const bootstrap = source('../bootstrap.ts');
    const preReady = source('../electron-pre-ready.ts');
    const main = source('../index.ts');
    const configureAt = bootstrap.indexOf('configureElectronBeforeReady()');
    const bootstrapAt = bootstrap.indexOf('void bootstrap()');
    const sentryAt = preReady.indexOf('initSentryMain()');
    const registerAt = preReady.indexOf('registerAssemblyAnnotationSceneScheme(protocol)');
    const installAt = main.indexOf('await installAssemblyAnnotationSceneProtocol(');
    const ipcAt = main.indexOf('registerAllIpcHandlers(');
    expect(configureAt).toBeGreaterThan(-1);
    expect(configureAt).toBeLessThan(bootstrapAt);
    expect(sentryAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(sentryAt);
    expect(preReady).not.toContain('app.whenReady()');
    expect(installAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(ipcAt);
  });

  it('proves the read invoke builds metadata plus a capability and never returns payload bytes', () => {
    const main = source('./genome-data.ts');
    const start = main.indexOf("'genome:readAssemblyAnnotationScene'");
    const end = main.indexOf("'genome:readAssemblyAnnotationSceneDetailV1'", start);
    const handler = main.slice(start, end);
    expect(handler).toContain(
      'return { ...metadata, resource, ...(colorRoles ? { colorRoles } : {}) }'
    );
    expect(handler).not.toMatch(/\bpayload\s*[:,]/);
    expect(handler).not.toContain('readAssemblyAnnotationSceneCache(');
    expect(handler).toContain("console.error('[assembly-annotation-scene] read failed'");
  });
});
