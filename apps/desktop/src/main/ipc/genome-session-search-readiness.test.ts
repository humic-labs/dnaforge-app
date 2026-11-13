import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type {
  AssemblyReferenceAssetGenerationV1,
  GenomeOpenSource,
  IndexedGenomeManifest,
  IndexedGenomeTabState,
} from '../../shared/indexed-genome';
import {
  assertGenomeOpenIntent,
  prepareGenomeSessionSearchReadiness,
} from './genome-session-search-readiness';

const MANIFEST: IndexedGenomeManifest = {
  chrom: 'chr11',
  fastaPath: '/workspace/index/chr11.fa',
  faiPath: '/workspace/index/chr11.fa.fai',
  gffPath: '/workspace/index/chr11.gff3.gz',
  tbiPath: '/workspace/index/chr11.gff3.gz.tbi',
  length: 135_086_622,
  circular: false,
};

const TAB_STATE: IndexedGenomeTabState = {
  sourcePath: MANIFEST.gffPath!,
  sourceExt: 'gff3.gz',
  chrom: MANIFEST.chrom,
  manifest: MANIFEST,
  metadata: { length: MANIFEST.length!, circular: false },
};

const ASSET_GENERATION: AssemblyReferenceAssetGenerationV1 = {
  contract: 'assembly-reference-asset-generation.v1',
  sourceFingerprint: 'a'.repeat(24),
  inventoryFingerprint: 'b'.repeat(64),
  themeMode: 'light',
};
const REFERENCE_ASSET_CACHE_ROOT = '/reference-assets';
const SEARCH_METADATA = { annotationFeatureCount: 42_731 } as const;

function standaloneSource(): GenomeOpenSource {
  return {
    sourcePath: MANIFEST.gffPath!,
    workspaceRoot: '/workspace',
    chrom: MANIFEST.chrom,
    manifest: MANIFEST,
    intent: { kind: 'reference-single' },
  };
}

describe('main genome-session search readiness', () => {
  it('keeps a standalone user reference non-ready until ingestion ensures both search indexes', async () => {
    let release!: (value: typeof SEARCH_METADATA) => void;
    const verification = new Promise<typeof SEARCH_METADATA>((resolve) => {
      release = resolve;
    });
    const ensureImportedReferenceSearchIndexes = vi.fn(() => verification);
    const verifyPreparedReferenceSearchIndexes = vi.fn();
    const verifyReferenceAssetGeneration = vi.fn(async () => undefined);
    let settled = false;
    const pending = prepareGenomeSessionSearchReadiness({
      source: standaloneSource(),
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes,
        verifyPreparedReferenceSearchIndexes,
        verifyReferenceAssetGeneration,
      },
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release(SEARCH_METADATA);

    const readiness = await pending;
    expect(readiness.status).toBe('ready');
    if (readiness.status !== 'ready') throw new Error('Expected ready search source');
    expect(readiness.annotationFeatureCount).toBe(42_731);
    expect(readiness.source.chromosomes).toEqual([
      {
        chrom: MANIFEST.chrom,
        sourcePath: MANIFEST.gffPath,
        manifest: MANIFEST,
        length: MANIFEST.length,
      },
    ]);
    expect(ensureImportedReferenceSearchIndexes).toHaveBeenCalledOnce();
    expect(verifyPreparedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyReferenceAssetGeneration).not.toHaveBeenCalled();
  });

  it('binds a first standalone open to the manifest produced during preparation', async () => {
    const source = standaloneSource();
    delete source.manifest;
    source.sourcePath = '/workspace/chr11.gbff';
    const ensureImportedReferenceSearchIndexes = vi.fn(async () => SEARCH_METADATA);

    await expect(
      prepareGenomeSessionSearchReadiness({
        source,
        preparedTabState: TAB_STATE,
        referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
        deps: {
          ensureImportedReferenceSearchIndexes,
          verifyPreparedReferenceSearchIndexes: vi.fn(),
          verifyReferenceAssetGeneration: vi.fn(async () => undefined),
        },
      })
    ).resolves.toMatchObject({
      status: 'ready',
      source: { chromosomes: [{ manifest: MANIFEST }] },
    });
    expect(ensureImportedReferenceSearchIndexes).toHaveBeenCalledOnce();
  });

  it('rejects a standalone reference when ingestion-time search preparation fails', async () => {
    await expect(
      prepareGenomeSessionSearchReadiness({
        source: standaloneSource(),
        preparedTabState: TAB_STATE,
        referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
        deps: {
          ensureImportedReferenceSearchIndexes: vi.fn(async () => {
            throw new Error('protein index verification failed');
          }),
          verifyPreparedReferenceSearchIndexes: vi.fn(),
          verifyReferenceAssetGeneration: vi.fn(async () => undefined),
        },
      })
    ).rejects.toThrow('protein index verification failed');
  });

  it('never invokes a search writer for a relabeled source canonically inside the prepared cache', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dnaforge-reference-search-ownership-'));
    try {
      const referenceAssetCacheRoot = join(temporaryRoot, 'reference-assets');
      const preparedWorkspace = join(referenceAssetCacheRoot, 'grch38');
      const rendererAlias = join(temporaryRoot, 'renderer-declared-workspace');
      await mkdir(preparedWorkspace, { recursive: true });
      await symlink(
        preparedWorkspace,
        rendererAlias,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const manifest: IndexedGenomeManifest = {
        chrom: 'chr11',
        fastaPath: join(rendererAlias, 'prepared', 'chr11.fa'),
        faiPath: join(rendererAlias, 'prepared', 'chr11.fa.fai'),
        gffPath: join(rendererAlias, 'prepared', 'chr11.gff3.gz'),
        tbiPath: join(rendererAlias, 'prepared', 'chr11.gff3.gz.tbi'),
        length: MANIFEST.length,
      };
      const source: GenomeOpenSource = {
        sourcePath: manifest.gffPath!,
        workspaceRoot: rendererAlias,
        chrom: manifest.chrom,
        manifest,
        intent: { kind: 'reference-single' },
      };
      const ensureImportedReferenceSearchIndexes = vi.fn();
      const verifyPreparedReferenceSearchIndexes = vi.fn();
      const verifyReferenceAssetGeneration = vi.fn();

      await expect(
        prepareGenomeSessionSearchReadiness({
          source,
          preparedTabState: {
            ...TAB_STATE,
            sourcePath: manifest.gffPath!,
            chrom: manifest.chrom,
            manifest,
          },
          referenceAssetCacheRoot,
          deps: {
            ensureImportedReferenceSearchIndexes,
            verifyPreparedReferenceSearchIndexes,
            verifyReferenceAssetGeneration,
          },
        })
      ).rejects.toThrow(
        'Prepared reference cache requires exact reference-assembly generation authority.'
      );
      expect(ensureImportedReferenceSearchIndexes).not.toHaveBeenCalled();
      expect(verifyPreparedReferenceSearchIndexes).not.toHaveBeenCalled();
      expect(verifyReferenceAssetGeneration).not.toHaveBeenCalled();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('keeps a prepared assembly read-only by verifying rather than ensuring search indexes', async () => {
    const exactReadiness = await prepareGenomeSessionSearchReadiness({
      source: standaloneSource(),
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes: vi.fn(async () => SEARCH_METADATA),
        verifyPreparedReferenceSearchIndexes: vi.fn(),
        verifyReferenceAssetGeneration: vi.fn(),
      },
    });
    expect(exactReadiness.status).toBe('ready');
    if (exactReadiness.status !== 'ready') throw new Error('Expected ready search source');
    const exact = exactReadiness.source;

    const ensureImportedReferenceSearchIndexes = vi.fn();
    const verifyPreparedReferenceSearchIndexes = vi.fn(async () => SEARCH_METADATA);
    const verifyReferenceAssetGeneration = vi.fn(async () => undefined);
    const source: GenomeOpenSource = {
      ...standaloneSource(),
      intent: {
        kind: 'reference-assembly',
        searchSource: exact,
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
        assetGeneration: ASSET_GENERATION,
      },
    };

    await expect(
      prepareGenomeSessionSearchReadiness({
        source,
        preparedTabState: TAB_STATE,
        referenceAssetCacheRoot: '/workspace',
        deps: {
          ensureImportedReferenceSearchIndexes,
          verifyPreparedReferenceSearchIndexes,
          verifyReferenceAssetGeneration,
        },
      })
    ).resolves.toEqual({
      status: 'ready',
      source: exact,
      annotationFeatureCount: 42_731,
    });
    expect(verifyReferenceAssetGeneration).toHaveBeenCalledWith(exact, ASSET_GENERATION, {
      signal: undefined,
    });
    expect(verifyPreparedReferenceSearchIndexes).toHaveBeenCalledWith(exact, {
      signal: undefined,
    });
    expect(ensureImportedReferenceSearchIndexes).not.toHaveBeenCalled();
  });

  it('propagates session cancellation through prepared-reference search admission', async () => {
    const exactReadiness = await prepareGenomeSessionSearchReadiness({
      source: standaloneSource(),
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes: vi.fn(async () => SEARCH_METADATA),
        verifyPreparedReferenceSearchIndexes: vi.fn(),
        verifyReferenceAssetGeneration: vi.fn(async () => undefined),
      },
    });
    if (exactReadiness.status !== 'ready') throw new Error('Expected ready search source');
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const verifyPreparedReferenceSearchIndexes = vi.fn(
      async (_source: unknown, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        return new Promise<typeof SEARCH_METADATA>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new Error('cancelled')),
            { once: true }
          );
        });
      }
    );
    const pending = prepareGenomeSessionSearchReadiness({
      source: {
        ...standaloneSource(),
        intent: {
          kind: 'reference-assembly',
          searchSource: exactReadiness.source,
          annotationProductsReadiness: 'ready',
          searchReadiness: 'ready',
          assetGeneration: ASSET_GENERATION,
        },
      },
      referenceAssetCacheRoot: '/workspace',
      deps: {
        ensureImportedReferenceSearchIndexes: vi.fn(),
        verifyPreparedReferenceSearchIndexes,
        verifyReferenceAssetGeneration: vi.fn(async () => undefined),
      },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(verifyPreparedReferenceSearchIndexes).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal).toBe(controller.signal);
  });

  it('admits a reference assembly with search pending without invoking search verification', async () => {
    const ensureImportedReferenceSearchIndexes = vi.fn();
    const verifyPreparedReferenceSearchIndexes = vi.fn();
    const verifyReferenceAssetGeneration = vi.fn();
    const source: GenomeOpenSource = {
      ...standaloneSource(),
      intent: {
        kind: 'reference-assembly',
        annotationProductsReadiness: 'pending',
        searchReadiness: 'pending',
      },
    };

    await expect(
      prepareGenomeSessionSearchReadiness({
        source,
        preparedTabState: TAB_STATE,
        referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
        deps: {
          ensureImportedReferenceSearchIndexes,
          verifyPreparedReferenceSearchIndexes,
          verifyReferenceAssetGeneration,
        },
      })
    ).resolves.toEqual({ status: 'pending' });
    expect(ensureImportedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyPreparedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyReferenceAssetGeneration).not.toHaveBeenCalled();
  });

  it('publishes sequence-only annotation search as not-applicable without invoking a writer', async () => {
    const sequenceManifest: IndexedGenomeManifest = {
      chrom: 'contig-1',
      fastaPath: '/workspace/index/contig-1.fa',
      faiPath: '/workspace/index/contig-1.fa.fai',
      gffPath: null,
      tbiPath: null,
      length: 12_345,
    };
    const ensureImportedReferenceSearchIndexes = vi.fn();
    const verifyPreparedReferenceSearchIndexes = vi.fn();
    const verifyReferenceAssetGeneration = vi.fn();

    await expect(
      prepareGenomeSessionSearchReadiness({
        source: {
          sourcePath: sequenceManifest.fastaPath,
          workspaceRoot: '/workspace',
          chrom: sequenceManifest.chrom,
          manifest: sequenceManifest,
          intent: {
            kind: 'reference-assembly',
            annotationProductsReadiness: 'not-applicable',
            searchReadiness: 'not-applicable',
          },
        },
        preparedTabState: {
          sourcePath: sequenceManifest.fastaPath,
          sourceExt: 'fa',
          chrom: sequenceManifest.chrom,
          manifest: sequenceManifest,
          metadata: { length: sequenceManifest.length!, circular: false },
        },
        referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
        deps: {
          ensureImportedReferenceSearchIndexes,
          verifyPreparedReferenceSearchIndexes,
          verifyReferenceAssetGeneration,
        },
      })
    ).resolves.toEqual({ status: 'not-applicable' });
    expect(ensureImportedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyPreparedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyReferenceAssetGeneration).not.toHaveBeenCalled();
  });

  it('rejects not-applicable when the exact opened manifest contains annotations', () => {
    expect(() =>
      assertGenomeOpenIntent({
        ...standaloneSource(),
        intent: {
          kind: 'reference-assembly',
          annotationProductsReadiness: 'not-applicable',
          searchReadiness: 'not-applicable',
        },
      })
    ).toThrow('invalid annotation capability contract');
  });

  it.each([
    { gffPath: MANIFEST.gffPath, tbiPath: null },
    { gffPath: null, tbiPath: MANIFEST.tbiPath },
  ])('rejects a partial annotation source pair', ({ gffPath, tbiPath }) => {
    expect(() =>
      assertGenomeOpenIntent({
        ...standaloneSource(),
        sourcePath: gffPath ?? MANIFEST.fastaPath,
        manifest: {
          ...MANIFEST,
          gffPath,
          tbiPath,
        },
        intent: {
          kind: 'reference-assembly',
          annotationProductsReadiness: 'pending',
          searchReadiness: 'pending',
        },
      })
    ).toThrow('invalid annotation capability contract');
  });

  it('rejects a reference assembly that collapses absent annotation into mixed readiness', () => {
    expect(() =>
      assertGenomeOpenIntent({
        ...standaloneSource(),
        intent: {
          kind: 'reference-assembly',
          annotationProductsReadiness: 'not-applicable',
          searchReadiness: 'pending',
        },
      })
    ).toThrow('invalid product/search readiness contract');
  });

  it('lets only explicitly internal segment sessions skip user-reference search readiness', async () => {
    const ensureImportedReferenceSearchIndexes = vi.fn();
    const verifyPreparedReferenceSearchIndexes = vi.fn();
    const verifyReferenceAssetGeneration = vi.fn();
    const result = await prepareGenomeSessionSearchReadiness({
      source: {
        ...standaloneSource(),
        intent: { kind: 'internal-assembly-segment' },
      },
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes,
        verifyPreparedReferenceSearchIndexes,
        verifyReferenceAssetGeneration,
      },
    });
    expect(result).toEqual({ status: 'not-required' });
    expect(ensureImportedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyPreparedReferenceSearchIndexes).not.toHaveBeenCalled();
    expect(verifyReferenceAssetGeneration).not.toHaveBeenCalled();
  });

  it('rejects an assembly intent whose authority is not bound to the opened exact manifest', async () => {
    const exactReadiness = await prepareGenomeSessionSearchReadiness({
      source: standaloneSource(),
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes: vi.fn(async () => SEARCH_METADATA),
        verifyPreparedReferenceSearchIndexes: vi.fn(),
        verifyReferenceAssetGeneration: vi.fn(async () => undefined),
      },
    });
    expect(exactReadiness.status).toBe('ready');
    if (exactReadiness.status !== 'ready') throw new Error('Expected ready search source');
    const exact = exactReadiness.source;
    const source: GenomeOpenSource = {
      ...standaloneSource(),
      manifest: { ...MANIFEST, fastaPath: '/workspace/other/chr11.fa' },
      intent: {
        kind: 'reference-assembly',
        searchSource: exact,
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
        assetGeneration: ASSET_GENERATION,
      },
    };
    expect(() => assertGenomeOpenIntent(source)).toThrow('opened exact manifest');
  });

  it('rejects an assembly intent that omits the opened chromosome manifest', async () => {
    const exactReadiness = await prepareGenomeSessionSearchReadiness({
      source: standaloneSource(),
      preparedTabState: TAB_STATE,
      referenceAssetCacheRoot: REFERENCE_ASSET_CACHE_ROOT,
      deps: {
        ensureImportedReferenceSearchIndexes: vi.fn(async () => SEARCH_METADATA),
        verifyPreparedReferenceSearchIndexes: vi.fn(),
        verifyReferenceAssetGeneration: vi.fn(async () => undefined),
      },
    });
    expect(exactReadiness.status).toBe('ready');
    if (exactReadiness.status !== 'ready') throw new Error('Expected ready search source');
    const exact = exactReadiness.source;
    const source: GenomeOpenSource = {
      sourcePath: MANIFEST.gffPath!,
      workspaceRoot: '/workspace',
      chrom: MANIFEST.chrom,
      intent: {
        kind: 'reference-assembly',
        searchSource: exact,
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
        assetGeneration: ASSET_GENERATION,
      },
    };

    expect(() => assertGenomeOpenIntent(source)).toThrow('exact opened chromosome manifest');
  });

  it('publishes the usable session before independent search admission', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const parsed = ts.createSourceFile('genome-data.ts', source, ts.ScriptTarget.Latest, true);
    const declaration = parsed.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'prepareGenomeSessionInBackground'
    );
    if (!declaration?.body) throw new Error('Background session preparation is missing');
    const javascript = ts.transpileModule(declaration.getText(parsed), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const shell = { sessionId: 'genome-test-1', coordinateReady: true };
    const sessions = new Map<string, unknown>([[shell.sessionId, shell]]);
    const sessionPreparations = new Map<string, AbortController>();
    const webContents = {};
    const publish = vi.fn();
    const markError = vi.fn(({ session }: { session: unknown }) => session);
    let rejectSearch!: (error: Error) => void;
    const search = new Promise<never>((_resolve, reject) => {
      rejectSearch = reject;
    });
    const prepare = runInNewContext(`${javascript}\nprepareGenomeSessionInBackground;`, {
      AbortController,
      Error,
      sessions,
      sessionPreparations,
      prepareIndexedGenomeSession: vi.fn(async () => ({
        tabState: TAB_STATE,
        reusedExistingIndex: true,
      })),
      updateGenomeSessionShellFromTabState: ({ session }: { session: unknown }) => session,
      withoutSessionReadinessDemotion: (_previous: unknown, next: unknown) => next,
      replaceGenomeSessionIfOwned: (store: Map<string, unknown>, id: string, next: unknown) => {
        if (!store.has(id)) return false;
        store.set(id, next);
        return true;
      },
      getOrCreateDiagnostics: () => ({}),
      updateSessionDiagnostics: vi.fn(),
      recordSessionUpdateTrace: vi.fn(),
      sendGenomeSessionUpdate: publish,
      annotationOverviewMayBeBuiltAtRuntime: () => false,
      startBackgroundAnnotationOverviewBuild: vi.fn(),
      prepareGenomeSessionSearchReadiness: () => search,
      currentReferenceAssetCacheRoot: () => REFERENCE_ASSET_CACHE_ROOT,
      genomeSessionSearchReadinessDeps: () => ({}),
      createPendingIndexedGenomeTabState: vi.fn(() => TAB_STATE),
      markGenomeSessionShellError: markError,
      withSource: vi.fn(),
    }) as (input: unknown) => Promise<void>;
    const completion = prepare({
      webContents,
      source: standaloneSource(),
      shell,
      stat: { size: 100, mtimeMs: 1, ctimeMs: 1 },
      workspaceRoot: '/workspace',
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenNthCalledWith(
      1,
      webContents,
      expect.objectContaining({
        prepareStatus: 'ready',
        shell: expect.objectContaining({ sessionId: shell.sessionId, openReady: true }),
      })
    );

    rejectSearch(new Error('search admission refused'));
    await completion;
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      2,
      webContents,
      expect.objectContaining({
        prepareStatus: 'ready',
        error: 'search admission refused',
        shell: expect.objectContaining({ sessionId: shell.sessionId, openReady: true }),
      })
    );
    expect(sessions.get(shell.sessionId)).toMatchObject({ openReady: true });
    expect(markError).not.toHaveBeenCalled();
    expect(sessionPreparations.has(shell.sessionId)).toBe(false);
  });

  it('upgrades detail and search on the existing verified session without reopening it', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const upgrade = source.indexOf("'genome:upgradeSessionCapabilities'");
    const implementation = source.indexOf('async function upgradeGenomeSessionCapabilities');
    const existingSession = source.indexOf(
      'const current = sessions.get(input.sessionId)',
      implementation
    );
    const registeredCancellationOwner = source.indexOf(
      'sessionPreparations.set(current.sessionId, capabilityController)',
      implementation
    );
    const firstAwaitedPathCheck = source.indexOf(
      'await assertSafePath(input.source.sourcePath)',
      implementation
    );
    const postCheckCancellationGate = source.indexOf(
      'assertUpgradeOwnerCurrent()',
      firstAwaitedPathCheck
    );
    const generationGate = source.indexOf('signal: capabilityController.signal', implementation);
    const sameSessionPublication = source.indexOf(
      'replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)',
      implementation
    );
    const implementationEnd = source.indexOf(
      'export function registerGenomeDataHandlers',
      implementation
    );

    expect(upgrade).toBeGreaterThan(-1);
    expect(implementation).toBeGreaterThan(-1);
    expect(existingSession).toBeGreaterThan(implementation);
    expect(registeredCancellationOwner).toBeGreaterThan(existingSession);
    expect(firstAwaitedPathCheck).toBeGreaterThan(registeredCancellationOwner);
    expect(postCheckCancellationGate).toBeGreaterThan(firstAwaitedPathCheck);
    expect(generationGate).toBeGreaterThan(existingSession);
    expect(generationGate).toBeGreaterThan(postCheckCancellationGate);
    expect(sameSessionPublication).toBeGreaterThan(generationGate);
    expect(source.slice(implementation, implementationEnd)).not.toContain(
      'createGenomeSessionShell('
    );
  });

  it('releases every renderer-owned genome resource on crash, destruction, or reload', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const lifecycleSource = await readFile(
      resolve(process.cwd(), 'src/main/renderer-owner-lifecycle.ts'),
      'utf8'
    );
    const lifecycle = source.indexOf('const genomeRendererLifecycle = new GenomeRendererLifecycle');
    const openHandler = source.indexOf("mainIpc.handle('genome:open'");
    const ownerRegistration = source.indexOf(
      'sessionOwners.set(shell.sessionId, webContents.id)',
      openHandler
    );
    const shellPublication = source.indexOf('sessions.set(shell.sessionId, shell)', openHandler);
    const senderCurrentGate = source.indexOf(
      'genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration)',
      openHandler
    );

    expect(lifecycle).toBeGreaterThan(-1);
    const release = source.slice(lifecycle, openHandler);
    expect(release).toContain('closeGenomeSessionsForRenderer(sessionLifecycleStores, ownerId)');
    expect(release).toContain('assemblyAnnotationSearchQueryLifecycle.cancelWebContents(ownerId)');
    expect(release).toContain('assemblyProteinSearchQueryLifecycle.cancelWebContents(ownerId)');
    expect(release).toContain('genomeSearchQueryLifecycle.cancelWebContents(ownerId)');
    expect(release).toContain('assemblyAnnotationSceneResourceRegistry.releaseOwner(ownerId)');
    expect(release).toContain('compiledBroadRasterCatalogCapabilities.releaseOwner(ownerId)');
    expect(lifecycleSource).toContain("sender.on('render-process-gone'");
    expect(lifecycleSource).toContain("sender.on('did-start-navigation'");
    expect(lifecycleSource).toContain("sender.once('destroyed'");
    expect(senderCurrentGate).toBeGreaterThan(openHandler);
    expect(shellPublication).toBeGreaterThan(senderCurrentGate);
    expect(ownerRegistration).toBeGreaterThan(shellPublication);
  });

  it('places canonical standalone ownership admission before creating a session or starting writers', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    const openHandler = source.indexOf("ipcMain.handle('genome:open'");
    const ownershipGate = source.indexOf(
      'await assertStandaloneReferenceSearchWriteAllowed({',
      openHandler
    );
    const shell = source.indexOf('const shell = createGenomeSessionShell', openHandler);
    expect(ownershipGate).toBeGreaterThan(openHandler);
    expect(shell).toBeGreaterThan(ownershipGate);
  });

  it('wires single-reference ingestion to ensure and prepared assemblies to portable-first verify-only', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/main/ipc/genome-data.ts'), 'utf8');
    expect(source).toContain(
      'const readiness = await assemblySearchReadiness.ensure(source, options)'
    );
    expect(source).toContain('verifyPreparedReferenceSearchIndexes: async (source, options) => {');
    expect(source).toContain(
      'portablePreparedReferenceViewAuthorityV1.readAnnotationSearchIndex(source)'
    );
    expect(source).toContain(
      'portablePreparedReferenceViewAuthorityV1.readProteinSearchIndex(source)'
    );
    expect(source).toContain('await assemblySearchReadiness.verifyPrepared(source, options)');
  });
});
