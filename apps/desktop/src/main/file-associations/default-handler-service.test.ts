import {
  createDefaultHandlerService,
  type DefaultHandlerServiceDependencies,
} from './default-handler-service';

function dependencies(
  overrides: Partial<DefaultHandlerServiceDependencies> = {}
): DefaultHandlerServiceDependencies {
  return {
    platform: 'darwin',
    appBundleId: 'com.dnaforge.desktop',
    queryMacHandler: vi.fn(async () => ({
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      path: '/System/Applications/TextEdit.app',
    })),
    setMacHandler: vi.fn(async () => ({ ok: true, detail: null })),
    queryWindowsProgIds: vi.fn(async () => ({})),
    openWindowsDefaultApps: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe(' effective default-handler service', () => {
  it('reports a factual macOS handler and native action', async () => {
    const service = createDefaultHandlerService(dependencies());
    await expect(service.queryAll()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: 'genbank',
          state: 'other',
          handlerName: 'TextEdit',
          handlerPath: '/System/Applications/TextEdit.app',
          defaultAction: 'native',
        }),
        expect.objectContaining({ familyId: 'snapgene', state: 'other' }),
      ])
    );
  });

  it('recognizes DNAForge as the effective macOS default', async () => {
    const deps = dependencies({
      queryMacHandler: vi.fn(async () => ({
        bundleId: 'com.dnaforge.desktop',
        name: 'DNAForge',
        path: '/Applications/DNAForge.app',
      })),
    });
    const statuses = await createDefaultHandlerService(deps).queryAll();
    expect(statuses.every((status) => status.state === 'default')).toBe(true);
  });

  it('requires every registered Windows extension to use the family ProgID', async () => {
    const defaults = new Map([
      ['gb', 'DNAForge.GenBank'],
      ['gbk', 'DNAForge.GenBank'],
      ['gbff', 'Other.GenBank'],
      ['genbank', 'DNAForge.GenBank'],
      ['dna', 'DNAForge.SnapGene'],
    ]);
    const service = createDefaultHandlerService(
      dependencies({
        platform: 'win32',
        queryWindowsProgIds: vi.fn(async () => Object.fromEntries(defaults)),
      })
    );

    await expect(service.queryAll()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: 'genbank',
          state: 'other',
          defaultAction: 'system-settings',
          detail: 'The registered GenBank extensions use different default applications.',
        }),
        expect.objectContaining({ familyId: 'snapgene', state: 'default' }),
      ])
    );
  });

  it('returns unavailable rather than guessing after a native query failure', async () => {
    const service = createDefaultHandlerService(
      dependencies({
        queryMacHandler: vi.fn(async () => {
          throw new Error('helper failed');
        }),
      })
    );
    const statuses = await service.queryAll();
    expect(
      statuses.every(
        (status) => status.state === 'unavailable' && status.detail === 'helper failed'
      )
    ).toBe(true);
  });

  it('uses the native macOS action and Windows registered-app Settings page', async () => {
    const macDeps = dependencies();
    const mac = createDefaultHandlerService(macDeps);
    await expect(mac.requestDefault('genbank')).resolves.toEqual({
      familyId: 'genbank',
      outcome: 'requested',
      detail: null,
    });
    expect(macDeps.setMacHandler).toHaveBeenCalledWith('genbank');

    const windowsDeps = dependencies({ platform: 'win32' });
    const windows = createDefaultHandlerService(windowsDeps);
    await expect(windows.requestDefault('genbank')).resolves.toEqual({
      familyId: 'genbank',
      outcome: 'opened-settings',
      detail: null,
    });
    expect(windowsDeps.openWindowsDefaultApps).toHaveBeenCalledOnce();
  });

  it('keeps a Finder-instructions action when unpackaged macOS cannot register itself', async () => {
    const service = createDefaultHandlerService(
      dependencies({
        macDefaultAction: 'instructions',
        queryMacHandler: vi.fn(async () => ({
          bundleId: 'com.gslbiotech.snapgene',
          name: 'SnapGene',
          path: '/Applications/SnapGene.app',
        })),
      })
    );
    await expect(service.queryAll()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: 'genbank',
          state: 'other',
          handlerName: 'SnapGene',
          defaultAction: 'instructions',
        }),
        expect.objectContaining({ familyId: 'snapgene', defaultAction: 'instructions' }),
      ])
    );
  });

  it('offers no Windows settings action to a development or preview process', async () => {
    const deps = dependencies({ platform: 'win32', windowsDefaultAction: 'none' });
    const service = createDefaultHandlerService(deps);
    await expect(service.requestDefault('genbank')).resolves.toMatchObject({
      outcome: 'unavailable',
    });
    expect(deps.openWindowsDefaultApps).not.toHaveBeenCalled();
  });

  it('reports unsupported platforms without exposing a false action', async () => {
    const service = createDefaultHandlerService(dependencies({ platform: 'linux' }));
    const statuses = await service.queryAll();
    expect(
      statuses.every((status) => status.state === 'unsupported' && status.defaultAction === 'none')
    ).toBe(true);
    await expect(service.requestDefault('genbank')).resolves.toMatchObject({
      outcome: 'unavailable',
    });
  });
});
