import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createNativeDefaultHandlerDependencies,
  parseMacHandlerResponse,
  resolveMacDefaultHandlerHelperPath,
} from './native-default-handler';

describe(' native default-handler adapters', () => {
  it('uses the entry-owned helper source independently of the process working directory', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'file-handler-source-'));
    const helperSourcePath = resolve(
      __dirname,
      '../../../resources/helpers-src/dnaforge-file-association.m'
    );
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: '{"ok":true,"handler":null}',
      stderr: '',
    }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/unrelated/checkouts/another-project');
    try {
      const dependencies = createNativeDefaultHandlerDependencies({
        platform: 'darwin',
        appBundleId: 'com.dnaforge.desktop',
        isPackaged: false,
        resourcesPath: '/Electron.app/Contents/Resources',
        execPath: '/Electron.app/Contents/MacOS/Electron',
        helperSourcePath,
        userDataPath,
        runCommand,
        openExternal: vi.fn(),
      });
      await expect(dependencies.queryMacHandler('genbank')).resolves.toBeNull();
      expect(runCommand).toHaveBeenCalledWith(
        '/usr/bin/xcrun',
        expect.arrayContaining([helperSourcePath])
      );
      expect(runCommand).toHaveBeenCalledWith(
        join(userDataPath, 'helpers', 'dnaforge-file-association'),
        ['query-extensions', 'gb', 'gbk', 'gbff', 'genbank']
      );
    } finally {
      cwd.mockRestore();
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('refuses an unpackaged native query without an explicitly owned helper source', async () => {
    const runCommand = vi.fn();
    const dependencies = createNativeDefaultHandlerDependencies({
      platform: 'darwin',
      appBundleId: 'com.dnaforge.desktop',
      isPackaged: false,
      resourcesPath: '/Electron.app/Contents/Resources',
      execPath: '/Electron.app/Contents/MacOS/Electron',
      runCommand,
      openExternal: vi.fn(),
    });
    await expect(dependencies.queryMacHandler('genbank')).rejects.toThrow(
      'Could not read the current default app'
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('parses the packaged macOS helper response without guessing', () => {
    expect(
      parseMacHandlerResponse(
        '{"ok":true,"handler":{"bundleId":"com.apple.TextEdit","name":"TextEdit","path":"/Applications/TextEdit.app"}}'
      )
    ).toEqual({
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      path: '/Applications/TextEdit.app',
    });
    expect(parseMacHandlerResponse('{"ok":true,"handler":null}')).toBeNull();
    expect(() => parseMacHandlerResponse('{"ok":false,"error":"LaunchServices failed"}')).toThrow(
      'LaunchServices failed'
    );
  });

  it('preserves the individual macOS handlers when a family has mixed defaults', () => {
    expect(
      parseMacHandlerResponse(
        JSON.stringify({
          ok: true,
          handler: { name: 'Multiple applications' },
          byExtension: { gb: { name: 'SnapGene', bundleId: 'com.gslbiotech.snapgene' }, gbk: null },
        })
      )?.mixedHandlers
    ).toEqual([
      { extension: 'gb', handlerName: 'SnapGene' },
      { extension: 'gbk', handlerName: null },
    ]);
  });

  it('distinguishes a Windows shell query failure from a genuinely unassociated extension', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValue({ code: 1, stderr: 'COM query failed', stdout: '' });
    const deps = createNativeDefaultHandlerDependencies({
      platform: 'win32',
      appBundleId: 'com.dnaforge.desktop',
      isPackaged: true,
      resourcesPath: 'resources',
      execPath: 'DNAForge.exe',
      runCommand,
      openExternal: vi.fn(),
    });
    await expect(deps.queryWindowsProgIds()).rejects.toThrow('COM query failed');
    const extensions = runCommand.mock.calls[0][1].at(-1).split(',') as string[];
    const results: Record<string, { progId: string; name: string } | null> = Object.fromEntries(
      extensions.map((extension) => [extension, null])
    );
    results.dna = { progId: 'SnapGene.DNA', name: 'SnapGene' };
    runCommand.mockResolvedValue({ code: 0, stderr: '', stdout: JSON.stringify(results) });
    await expect(deps.queryWindowsProgIds()).resolves.toEqual(results);
  });

  it('resolves the helper beside the packaged app Helpers directory only', () => {
    expect(
      resolveMacDefaultHandlerHelperPath({
        isPackaged: true,
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      })
    ).toBe('/Applications/DNAForge.app/Contents/Helpers/dnaforge-file-association');
    expect(
      resolveMacDefaultHandlerHelperPath({ isPackaged: false, resourcesPath: '/tmp/resources' })
    ).toBeNull();
  });

  it('queries macOS through the helper and opens the Windows registered-app page', async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout:
        '{"ok":true,"handler":{"bundleId":"com.dnaforge.desktop","name":"DNAForge","path":"/Applications/DNAForge.app"}}',
      stderr: '',
    }));
    const openExternal = vi.fn(async () => undefined);
    const mac = createNativeDefaultHandlerDependencies({
      platform: 'darwin',
      appBundleId: 'com.dnaforge.desktop',
      isPackaged: true,
      resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      execPath: '/Applications/DNAForge.app/Contents/MacOS/DNAForge',
      runCommand,
      openExternal,
    });
    await expect(mac.queryMacHandler('genbank')).resolves.toMatchObject({
      bundleId: 'com.dnaforge.desktop',
    });
    expect(runCommand).toHaveBeenCalledWith(
      '/Applications/DNAForge.app/Contents/Helpers/dnaforge-file-association',
      ['query-extensions', 'gb', 'gbk', 'gbff', 'genbank']
    );

    const windows = createNativeDefaultHandlerDependencies({
      platform: 'win32',
      appBundleId: 'com.dnaforge.desktop',
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\DNAForge\\resources',
      execPath: 'C:\\Program Files\\DNAForge\\DNAForge.exe',
      runCommand,
      openExternal,
    });
    await windows.openWindowsDefaultApps();
    expect(openExternal).toHaveBeenCalledWith('ms-settings:defaultapps?registeredAppUser=DNAForge');
  });

  it('queries unpackaged macOS handlers by extension and refuses to register Electron', async () => {
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => ({
      code: 0,
      stdout:
        args[1] === 'dna'
          ? '{"ok":true,"handler":{"bundleId":"com.gslbiotech.snapgene","name":"SnapGene","path":"/Applications/SnapGene.app"}}'
          : '{"ok":true,"handler":{"bundleId":"com.apple.Preview","name":"Preview","path":"/System/Applications/Preview.app"}}',
      stderr: '',
    }));
    const unpackaged = createNativeDefaultHandlerDependencies({
      platform: 'darwin',
      appBundleId: 'com.dnaforge.desktop',
      isPackaged: false,
      resourcesPath: '/tmp/resources',
      execPath: '/tmp/Electron',
      unpackagedHelperPath: '/tmp/dnaforge-file-association',
      runCommand,
      openExternal: vi.fn(async () => undefined),
    });

    await expect(unpackaged.queryMacHandler('genbank')).resolves.toMatchObject({
      name: 'Preview',
    });
    expect(runCommand).toHaveBeenCalledWith('/tmp/dnaforge-file-association', [
      'query-extensions',
      'gb',
      'gbk',
      'gbff',
      'genbank',
    ]);
    expect(unpackaged.macDefaultAction).toBe('instructions');
    await expect(unpackaged.setMacHandler('genbank')).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('development window'),
    });
  });
});
