import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HANDLER_FAMILIES, handlerFamily } from '../../shared/file-associations';
import type {
  DefaultHandlerServiceDependencies,
  MacHandlerIdentity,
  WindowsHandlers,
} from './default-handler-service';

export interface NativeCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NativeCommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<NativeCommandResult>;

export interface NativeDefaultHandlerOptions {
  readonly platform: NodeJS.Platform;
  readonly appBundleId: string;
  readonly isPackaged: boolean;
  readonly allowDefaultChanges?: boolean;
  readonly resourcesPath: string;
  readonly execPath: string;
  readonly userDataPath?: string;
  readonly helperSourcePath?: string;
  readonly unpackagedHelperPath?: string;
  readonly runCommand?: NativeCommandRunner;
  readonly openExternal: (url: string) => Promise<unknown>;
}

function defaultRunCommand(command: string, args: readonly string[]): Promise<NativeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as NodeJS.ErrnoException & { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The native handler helper returned an invalid response.');
  }
  return parsed as Record<string, unknown>;
}

function helperError(response: Record<string, unknown>): string {
  return typeof response.error === 'string' && response.error.trim() !== ''
    ? response.error
    : 'The native handler helper failed.';
}

export function parseMacHandlerResponse(stdout: string): MacHandlerIdentity | null {
  const response = parseObject(stdout);
  if (response.ok !== true) throw new Error(helperError(response));
  if (response.handler === null) return null;
  if (typeof response.handler !== 'object' || response.handler === null) {
    throw new Error('The native handler helper omitted its handler result.');
  }
  const handler = response.handler as Record<string, unknown>;
  const mixedHandlers =
    handler.name === 'Multiple applications' && response.byExtension
      ? Object.entries(response.byExtension).map(([extension, entry]) => ({
          extension,
          handlerName: entry?.name ?? entry?.bundleId ?? null,
        }))
      : undefined;
  return {
    ...(mixedHandlers && { mixedHandlers }),
    bundleId:
      typeof handler.bundleId === 'string' && handler.bundleId !== '' ? handler.bundleId : null,
    name: typeof handler.name === 'string' && handler.name !== '' ? handler.name : null,
    path: typeof handler.path === 'string' && handler.path !== '' ? handler.path : null,
  };
}

export function resolveMacDefaultHandlerHelperPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): string | null {
  if (!input.isPackaged) return null;
  return path.resolve(input.resourcesPath, '..', 'Helpers', 'dnaforge-file-association');
}

function helperIsCurrent(sourcePath: string, outputPath: string): boolean {
  if (!existsSync(outputPath)) return false;
  return statSync(outputPath).mtimeMs >= statSync(sourcePath).mtimeMs;
}

function clangArch(nodeArch: string): 'arm64' | 'x86_64' | null {
  if (nodeArch === 'arm64') return 'arm64';
  if (nodeArch === 'x64') return 'x86_64';
  return null;
}

function macApplicationBundlePath(execPath: string): string {
  return path.resolve(path.dirname(execPath), '..', '..');
}

async function runHelperQuery(
  runCommand: NativeCommandRunner,
  helperPath: string,
  args: readonly string[]
): Promise<MacHandlerIdentity | null> {
  const result = await runCommand(helperPath, args);
  if (result.code !== 0 && result.stdout.trim() === '') {
    throw new Error(result.stderr.trim() || 'The macOS handler query failed.');
  }
  return parseMacHandlerResponse(result.stdout);
}

export function createNativeDefaultHandlerDependencies(
  options: NativeDefaultHandlerOptions
): DefaultHandlerServiceDependencies {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const packagedHelperPath = resolveMacDefaultHandlerHelperPath(options);
  let unpackagedHelperPromise: Promise<string | null> | null = null;

  const ensureUnpackagedQueryHelper = async (): Promise<string | null> => {
    if (options.unpackagedHelperPath) return options.unpackagedHelperPath;
    if (!unpackagedHelperPromise) {
      unpackagedHelperPromise = (async () => {
        const sourcePath = options.helperSourcePath;
        if (!sourcePath) return null;
        const outputPath = path.join(
          options.userDataPath ?? os.tmpdir(),
          'helpers',
          'dnaforge-file-association'
        );
        if (helperIsCurrent(sourcePath, outputPath)) return outputPath;
        const arch = clangArch(process.arch);
        if (!arch) return null;
        mkdirSync(path.dirname(outputPath), { recursive: true });
        const result = await runCommand('/usr/bin/xcrun', [
          'clang',
          '-fobjc-arc',
          '-fblocks',
          '-mmacosx-version-min=12.0',
          sourcePath,
          '-framework',
          'AppKit',
          '-framework',
          'UniformTypeIdentifiers',
          '-arch',
          arch,
          '-o',
          outputPath,
        ]);
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || 'Could not build the macOS default-app helper.');
        }
        return outputPath;
      })().catch((error) => {
        unpackagedHelperPromise = null;
        throw error;
      });
    }
    return unpackagedHelperPromise;
  };

  const allowDefaultChanges = options.isPackaged && options.allowDefaultChanges === true;
  return {
    platform: options.platform,
    appBundleId: options.appBundleId,
    windowsDefaultAction: allowDefaultChanges ? 'system-settings' : 'none',
    macDefaultAction: allowDefaultChanges ? 'native' : 'instructions',
    queryMacHandler: async (familyId) => {
      const family = handlerFamily(familyId);
      const helperPath = packagedHelperPath ?? (await ensureUnpackagedQueryHelper());
      if (!helperPath) {
        throw new Error('Could not read the current default app from macOS.');
      }
      return runHelperQuery(runCommand, helperPath, ['query-extensions', ...family.extensions]);
    },
    setMacHandler: async (familyId) => {
      if (!packagedHelperPath || !allowDefaultChanges) {
        return {
          ok: false,
          detail:
            'This development window cannot register itself as the default app. Install packaged DNAForge, then use Finder → Get Info → Open with → Change All.',
        };
      }
      const family = handlerFamily(familyId);
      const result = await runCommand(packagedHelperPath, [
        'set-extensions',
        macApplicationBundlePath(options.execPath),
        family.macTypeIds.join(','),
        ...family.extensions,
      ]);
      if (result.stdout.trim() !== '') {
        const response = parseObject(result.stdout);
        if (response.ok === true) return { ok: true, detail: null };
        return { ok: false, detail: helperError(response) };
      }
      return {
        ok: false,
        detail: result.stderr.trim() || 'The macOS default-app request failed.',
      };
    },
    queryWindowsProgIds: async () => {
      const script = options.isPackaged
        ? path.join(options.resourcesPath, 'query-windows-associations.ps1')
        : path.join(path.dirname(options.helperSourcePath ?? ''), 'query-windows-associations.ps1');
      const extensions = HANDLER_FAMILIES.flatMap((family) => family.extensions);
      const executable = path.win32.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const result = await runCommand(executable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        script,
        '-Extensions',
        extensions.join(','),
      ]);
      if (result.code !== 0)
        throw new Error(result.stderr.trim() || 'Windows default-app query failed.');
      const raw = parseObject(result.stdout);
      const defaults: Record<string, WindowsHandlers[string]> = {};
      for (const extension of extensions) {
        const value = raw[extension];
        if (value === null) {
          defaults[extension] = null;
          continue;
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !('progId' in value) ||
          typeof value.progId !== 'string' ||
          !('name' in value) ||
          typeof value.name !== 'string'
        ) {
          throw new Error(`Invalid Windows handler for .${extension}.`);
        }
        defaults[extension] = { progId: value.progId, name: value.name };
      }
      return defaults;
    },
    openWindowsDefaultApps: async () => {
      await options.openExternal('ms-settings:defaultapps?registeredAppUser=DNAForge');
    },
  };
}
